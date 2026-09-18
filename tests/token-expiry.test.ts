import { DEFAULT_WORKSPACE_ID } from '@/db/repository';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Regression coverage for API-token expiry enforcement (s7).
 *
 * The worker runs in Miniflare in PRODUCTION mode behind a real signed-in
 * admin session (no dev allowlist). The fixture applies the real drizzle/
 * migrations (including the nullable api_tokens.expires_at added in s1)
 * against in-memory D1 and seeds legacy/expired hashed rows directly, so
 * the legacy NULL-expiry compatibility path and the 401-before-writes
 * ordering are exercised against the same database the Worker uses.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Token expiry tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

// Better Auth requires a sufficiently long secret; any fixed test value works.
const SECRET = 'test-secret-test-secret-test-secret-12';
const ORIGIN = 'https://token-expiry-test.example';
const SETUP_TOKEN = 'test-token-expiry'.padEnd(32, '!');
const DAY_MS = 86_400_000;
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const workerScripts = new Map<string, string>();

const bundleWorker = async (): Promise<string> => {
  const cached = workerScripts.get('default');
  if (cached) {
    return cached;
  }

  await assertRepoRoot();
  const bundled = await build({
    bundle: true,
    entryPoints: [join(repoRoot, 'src/worker-global.ts')],
    external: ['cloudflare:*', 'node:*'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: join(repoRoot, 'tsconfig.json'),
    write: false,
  });
  const script = bundled.outputFiles[0].text;
  workerScripts.set('default', script);
  return script;
};

type Fixture = {
  count: (table: string) => Promise<number>;
  db: D1Database;
  dispose: () => Promise<void>;
  raw: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<RawResult>;
};

type RawResult = {
  cookie: string;
  json: Record<string, unknown>;
  status: number;
};

const startFixture = async (): Promise<Fixture> => {
  const script = await bundleWorker();
  const bindings: Record<string, string> = {
    BETTER_AUTH_SECRET: SECRET,
    ENVIRONMENT: 'production',
    SETUP_TOKEN,
  };

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings,
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script,
    }),
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }

    disposed = true;
    await mf.dispose();
  };

  try {
    const database = await mf.getD1Database('DB');
    const names = (await readdir(join(repoRoot, 'drizzle')))
      .filter((name) => name.endsWith('.sql'))
      .toSorted();
    for (const name of names) {
      const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((chunk) => chunk.trim())
        .filter(Boolean)) {
        await database.prepare(statement).run();
      }
    }

    const raw = async (
      path: string,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<RawResult> => {
      const response = await mf.dispatchFetch(`${ORIGIN}${path}`, {
        headers: {
          // Better Auth treats a Cookie-bearing request without a trusted
          // Origin as a CSRF failure (403 MISSING_OR_NULL_ORIGIN); send the
          // trusted origin explicitly.
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          ...headers,
        },
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }

      const cookie = (response.headers.getSetCookie?.() ?? [])
        .map((value) => value.split(';')[0])
        .join('; ');
      return { cookie, json, status: response.status };
    };

    return {
      count: async (table: string) =>
        ((await database.prepare(`SELECT count(*) AS n FROM ${table}`).first())
          ?.n ?? 0) as number,
      db: database,
      dispose,
      raw,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const signUp = async (fx: Fixture): Promise<string> => {
  const result = await fx.raw(
    '/api/auth/sign-up/email',
    'POST',
    {
      email: 'admin@example.test',
      name: 'Test Admin',
      password: 'correct-horse-battery',
    },
    { 'X-Setup-Token': SETUP_TOKEN },
  );
  expect(result.status, JSON.stringify(result)).toBe(200);
  expect(result.cookie).not.toBe('');
  return result.cookie;
};

const createToken = (
  fx: Fixture,
  cookie: string,
  body: { expiresAt?: string; name: string },
) => fx.raw('/v1/tokens', 'POST', body, { Cookie: cookie });

// Seeds a hashed api_tokens row directly in D1 (legacy deployments wrote
// tokens with a NULL expiry; expired rows model the post-s7 state).
const seedToken = async (
  fx: Fixture,
  id: string,
  rawToken: string,
  expiresAt: null | string,
  revokedAt: null | string = null,
): Promise<void> => {
  await fx.db
    .prepare(
      'INSERT INTO api_tokens (id,name,prefix,token_hash,scope,workspace_id,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      id,
      id,
      rawToken.slice(0, 12),
      sha256(rawToken),
      'intake:write',
      DEFAULT_WORKSPACE_ID,
      new Date().toISOString(),
      expiresAt,
      revokedAt,
    )
    .run();
};

const intake = (fx: Fixture, token: string, key: string, email: string) =>
  fx.raw(
    '/v1/intakes',
    'POST',
    {
      contact: { email },
      opportunity: { name: 'Token expiry probe', source: 'test' },
      source: 'test',
    },
    { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
  );

test('token creation defaults to a finite ~90-day future expiry', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const created = await createToken(fx, cookie, { name: 'default-expiry' });
    expect(created.status, JSON.stringify(created)).toBe(201);
    const data = created.json.data as {
      expiresAt: string;
      prefix: string;
      token: string;
    };
    expect(typeof data.token).toBe('string');
    expect(data.token.length).toBeGreaterThanOrEqual(32);
    expect(data.prefix).toBe(data.token.slice(0, 12));
    expect(typeof data.expiresAt).toBe('string');
    const ttl = Date.parse(data.expiresAt) - Date.now();
    expect(Number.isFinite(ttl)).toBe(true);
    expect(ttl, `ttl=${ttl}`).toBeGreaterThan(89 * DAY_MS);
    expect(ttl, `ttl=${ttl}`).toBeLessThan(91 * DAY_MS);

    // Hash-only persistence; the stored expiry matches the response.
    const row = await fx.db
      .prepare('SELECT expires_at, token_hash FROM api_tokens')
      .first<{ expires_at: string; token_hash: string }>();
    expect(row?.expires_at).toBe(data.expiresAt);
    expect(row?.token_hash).toBe(sha256(data.token));
  } finally {
    await fx.dispose();
  }
});

test('token creation accepts a future ISO expiry and rejects past or invalid values', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);

    const custom = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const ok = await createToken(fx, cookie, {
      expiresAt: custom,
      name: 'custom',
    });
    expect(ok.status, JSON.stringify(ok)).toBe(201);
    expect((ok.json.data as { expiresAt: string }).expiresAt).toBe(custom);

    // A date-only future instant is accepted by the shared ISO rule.
    const dateOnly = await createToken(fx, cookie, {
      expiresAt: '2099-01-01',
      name: 'date-only',
    });
    expect(dateOnly.status, JSON.stringify(dateOnly)).toBe(201);

    const past = await createToken(fx, cookie, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      name: 'past',
    });
    expect(past.status, JSON.stringify(past)).toBe(422);
    expect(past.json.code).toBe('validation_error');

    const notADate = await createToken(fx, cookie, {
      expiresAt: 'not-a-date',
      name: 'invalid',
    });
    expect(notADate.status, JSON.stringify(notADate)).toBe(422);
    expect(notADate.json.code).toBe('validation_error');

    // Rejected creates leave no token row behind.
    const rows = await fx.db
      .prepare('SELECT count(*) AS n FROM api_tokens')
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  } finally {
    await fx.dispose();
  }
});

test('token list exposes expiresAt and never a raw token or hash', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const created = await createToken(fx, cookie, { name: 'listed' });
    expect(created.status, JSON.stringify(created)).toBe(201);
    const data = created.json.data as {
      expiresAt: string;
      id: string;
      token: string;
    };
    const legacyRaw = 'legacy-token-0123456789abcdef';
    await seedToken(fx, 'legacy-listed', legacyRaw, null);

    const list = await fx.raw('/v1/tokens', 'GET', undefined, {
      Cookie: cookie,
    });
    expect(list.status, JSON.stringify(list)).toBe(200);
    const rows = list.json.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.hasOwn(row, 'expiresAt'), JSON.stringify(row)).toBe(true);
      expect(Object.hasOwn(row, 'token')).toBe(false);
      expect(Object.hasOwn(row, 'tokenHash')).toBe(false);
    }

    const listed = rows.find((row) => row.id === data.id);
    expect(listed?.expiresAt).toBe(data.expiresAt);
    const legacy = rows.find((row) => row.id === 'legacy-listed');
    // Legacy NULL expiry is reported exactly as NULL.
    expect(legacy?.expiresAt).toBe(null);
    const listText = JSON.stringify(list.json);
    expect(listText).not.toContain(data.token);
    expect(listText).not.toContain(sha256(data.token));
    expect(listText).not.toContain(legacyRaw);
  } finally {
    await fx.dispose();
  }
});

test('intake accepts legacy NULL-expiry tokens and future-expiry tokens', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const legacyRaw = 'legacy-token-0123456789abcdef';
    await seedToken(fx, 'legacy-intake', legacyRaw, null);
    const created = await createToken(fx, cookie, { name: 'live' });
    expect(created.status).toBe(201);
    const liveRaw = (created.json.data as { token: string }).token;

    const legacy = await intake(
      fx,
      legacyRaw,
      'token-expiry-legacy',
      'legacy-intake@example.test',
    );
    expect(legacy.status, JSON.stringify(legacy)).toBe(201);
    const live = await intake(
      fx,
      liveRaw,
      'token-expiry-live',
      'live-intake@example.test',
    );
    expect(live.status, JSON.stringify(live)).toBe(201);
    expect(await fx.count('idempotency_keys')).toBe(2);

    // Last-used behavior is preserved for both shapes.
    for (const id of [
      'legacy-intake',
      (created.json.data as { id: string }).id,
    ]) {
      const row = await fx.db
        .prepare('SELECT last_used_at FROM api_tokens WHERE id = ?')
        .bind(id)
        .first<{ last_used_at: null | string }>();
      expect(row?.last_used_at, `last_used_at for ${id}`).not.toBeNull();
    }
  } finally {
    await fx.dispose();
  }
});

test('intake rejects expired tokens with 401 before any idempotency or domain write', async () => {
  const fx = await startFixture();
  try {
    const expiredRaw = 'expired-token-0123456789abcdef';
    await seedToken(
      fx,
      'expired-token',
      expiredRaw,
      new Date(Date.now() - 1_000).toISOString(),
    );
    // Boundary row: its expiry equals the instant captured immediately
    // before the request, so at decision time expiresAt <= now must hold
    // (same-millisecond equality included).
    const boundaryRaw = 'boundary-token-0123456789abcdef';
    const boundary = new Date().toISOString();
    await seedToken(fx, 'boundary-token', boundaryRaw, boundary);

    const idemBefore = await fx.count('idempotency_keys');
    const contactsBefore = await fx.count('contacts');
    const opportunitiesBefore = await fx.count('opportunities');

    const expired = await intake(
      fx,
      expiredRaw,
      'token-expiry-expired',
      'expired-intake@example.test',
    );
    expect(expired.status, JSON.stringify(expired)).toBe(401);
    expect(expired.json.code).toBe('unauthorized');
    const boundaryResult = await intake(
      fx,
      boundaryRaw,
      'token-expiry-boundary',
      'boundary-intake@example.test',
    );
    expect(boundaryResult.status, JSON.stringify(boundaryResult)).toBe(401);
    expect(boundaryResult.json.code).toBe('unauthorized');

    expect(await fx.count('idempotency_keys')).toBe(idemBefore);
    expect(await fx.count('contacts')).toBe(contactsBefore);
    expect(await fx.count('opportunities')).toBe(opportunitiesBefore);

    // A denied token must not be marked as used.
    for (const id of ['expired-token', 'boundary-token']) {
      const row = await fx.db
        .prepare('SELECT last_used_at FROM api_tokens WHERE id = ?')
        .bind(id)
        .first<{ last_used_at: null | string }>();
      expect(row?.last_used_at, `last_used_at for ${id}`).toBeNull();
    }
  } finally {
    await fx.dispose();
  }
});

test('intake still rejects revoked tokens with 401', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const created = await createToken(fx, cookie, { name: 'to-revoke' });
    expect(created.status).toBe(201);
    const data = created.json.data as { id: string; token: string };
    const revoked = await fx.raw(`/v1/tokens/${data.id}`, 'DELETE', undefined, {
      Cookie: cookie,
    });
    expect(revoked.status, JSON.stringify(revoked)).toBe(204);

    const idemBefore = await fx.count('idempotency_keys');
    const denied = await intake(
      fx,
      data.token,
      'token-expiry-revoked',
      'revoked-intake@example.test',
    );
    expect(denied.status, JSON.stringify(denied)).toBe(401);
    expect(denied.json.code).toBe('unauthorized');
    expect(await fx.count('idempotency_keys')).toBe(idemBefore);
  } finally {
    await fx.dispose();
  }
});
