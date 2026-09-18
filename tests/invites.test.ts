import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Regression coverage for the staff invitation lifecycle (s3).
 *
 * The worker runs in Miniflare in PRODUCTION mode, so every protected
 * route resolves a Better Auth session from the request cookie. The
 * fixture applies the real drizzle/ migrations (including staff_invites
 * and the seeded bootstrap_state singleton) against in-memory D1. The
 * raw token only ever appears in the create response; persistence and
 * validation work on the SHA-256 hash.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Invite tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

// Better Auth requires a sufficiently long secret; any fixed test value works.
const SECRET = 'test-secret-test-secret-test-secret-12';
const ORIGIN = 'https://invites-test.example';
const SETUP_TOKEN = 'test-invite-token'.padEnd(32, '!');
const DAY_MS = 86_400_000;
const UNAVAILABLE_MESSAGE = 'Invitation is unavailable.';

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
  db: D1Database;
  dispose: () => Promise<void>;
  raw: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
    origin?: null | string,
  ) => Promise<RawResult>;
};

type FixtureOptions = {
  // null removes the binding from the fixture entirely (bootstrap mode).
  staffEmails?: null | string;
};

type RawResult = {
  cookie: string;
  json: Record<string, unknown>;
  status: number;
};

const startFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const script = await bundleWorker();
  const bindings: Record<string, string> = {
    BETTER_AUTH_SECRET: SECRET,
    ENVIRONMENT: 'production',
    SETUP_TOKEN,
  };
  if (options.staffEmails !== null) {
    bindings.STAFF_EMAILS = options.staffEmails ?? 'admin@example.test';
  }

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
      origin: null | string = ORIGIN,
    ): Promise<RawResult> => {
      const response = await mf.dispatchFetch(`${ORIGIN}${path}`, {
        headers: {
          'Content-Type': 'application/json',
          // A null origin omits the header entirely (non-browser client).
          ...(origin === null ? {} : { Origin: origin }),
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

    return { db: database, dispose, raw };
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

const createInvite = async (
  fx: Fixture,
  cookie: string,
  body: { expiresAt?: string; name: string },
): Promise<RawResult> =>
  fx.raw('/v1/invites', 'POST', body, { Cookie: cookie });

const expectUnavailable = (result: RawResult, label: string) => {
  expect(result.status, `${label}: ${JSON.stringify(result)}`).toBe(403);
  expect(result.json.code, `${label}: ${JSON.stringify(result)}`).toBe(
    'invite_unavailable',
  );
  expect(result.json.message, `${label}: ${JSON.stringify(result)}`).toBe(
    UNAVAILABLE_MESSAGE,
  );
};

test('invite management requires an authenticated staff session', async () => {
  const fx = await startFixture();
  try {
    for (const [path, method, body] of [
      ['/v1/invites', 'GET', undefined],
      ['/v1/invites', 'POST', { name: 'no-session' }],
      ['/v1/invites/01ARZ3NDEKTSV4RRFFQ69G5FAX', 'DELETE', undefined],
    ] as const) {
      const result = await fx.raw(path, method, body);
      expect(
        result.status,
        `${method} ${path}: ${JSON.stringify(result)}`,
      ).toBe(401);
      expect(result.json.code, `${method} ${path}`).toBe('unauthorized');
    }
  } finally {
    await fx.dispose();
  }
});

test('invite lifecycle: create, list, validate, revoke', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);

    const created = await createInvite(fx, cookie, {
      name: 'Verification invite',
    });
    expect(created.status, JSON.stringify(created)).toBe(201);
    const data = created.json.data as {
      createdAt: string;
      expiresAt: string;
      id: string;
      name: string;
      prefix: string;
      token: string;
    };
    expect(typeof data.token).toBe('string');
    expect(data.token.length).toBeGreaterThanOrEqual(32);
    expect(data.prefix).toBe(data.token.slice(0, 12));
    expect(data.name).toBe('Verification invite');
    const ttl = new Date(data.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(6 * DAY_MS);
    expect(ttl).toBeLessThan(8 * DAY_MS);

    // Hash-only persistence: the stored hash matches, the raw token is not.
    const row = await fx.db
      .prepare('SELECT token_hash FROM staff_invites')
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(
      createHash('sha256').update(data.token).digest('hex'),
    );

    const list = await fx.raw('/v1/invites', 'GET', undefined, {
      Cookie: cookie,
    });
    expect(list.status).toBe(200);
    const rows = list.json.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      expiresAt: data.expiresAt,
      id: data.id,
      name: 'Verification invite',
      prefix: data.prefix,
      revokedAt: null,
      usedAt: null,
    });
    const listText = JSON.stringify(list.json);
    expect(listText).not.toContain(data.token);
    expect(listText).not.toContain(row?.token_hash ?? '∅');
    expect(Object.hasOwn(rows[0], 'tokenHash')).toBe(false);
    expect(Object.hasOwn(rows[0], 'token')).toBe(false);

    // Non-consuming validation from the same origin without a cookie.
    const valid = await fx.raw('/api/invites/validate', 'POST', {
      token: data.token,
    });
    expect(valid.status, JSON.stringify(valid)).toBe(200);
    expect(valid.json).toEqual({ valid: true });
    const used = await fx.db
      .prepare('SELECT used_at FROM staff_invites')
      .first<{ used_at: null | string }>();
    expect(used?.used_at, 'validate must not consume the invite').toBeNull();

    // Revocation closes the invite; unknown ids are 404.
    const deleted = await fx.raw(
      `/v1/invites/${data.id}`,
      'DELETE',
      undefined,
      {
        Cookie: cookie,
      },
    );
    expect(deleted.status, JSON.stringify(deleted)).toBe(204);
    expectUnavailable(
      await fx.raw('/api/invites/validate', 'POST', { token: data.token }),
      'revoked invite',
    );
    const missing = await fx.raw(
      '/v1/invites/01ARZ3NDEKTSV4RRFFQ69G5FAX',
      'DELETE',
      undefined,
      { Cookie: cookie },
    );
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe('not_found');
  } finally {
    await fx.dispose();
  }
});

test('validate rejects hostile browser origins, allows non-browser clients', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const created = await createInvite(fx, cookie, { name: 'origin check' });
    const token = (created.json.data as { token: string }).token;

    const hostile = await fx.raw(
      '/api/invites/validate',
      'POST',
      { token },
      {},
      'https://attacker.example',
    );
    expect(hostile.status, JSON.stringify(hostile)).toBeGreaterThanOrEqual(400);
    expect(hostile.status, JSON.stringify(hostile)).toBeLessThan(500);

    // A missing Origin header (non-browser client) is allowed.
    const noOrigin = await fx.raw(
      '/api/invites/validate',
      'POST',
      { token },
      {},
      null,
    );
    expect(noOrigin.status, JSON.stringify(noOrigin)).toBe(200);
    expect(noOrigin.json).toEqual({ valid: true });

    // The invite is still available afterwards (the hostile attempt did
    // not consume or corrupt it).
    const sameOrigin = await fx.raw('/api/invites/validate', 'POST', {
      token,
    });
    expect(sameOrigin.status, JSON.stringify(sameOrigin)).toBe(200);
  } finally {
    await fx.dispose();
  }
});

// eslint-disable-next-line vitest/expect-expect -- expectUnavailable wraps expect()
test('validate reports invite_unavailable for unknown or empty tokens', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const created = await createInvite(fx, cookie, { name: 'wrong tokens' });
    const token = (created.json.data as { token: string }).token;

    for (const candidate of ['wrong-token', '', `wrong-${token}`]) {
      expectUnavailable(
        await fx.raw('/api/invites/validate', 'POST', { token: candidate }),
        `token ${JSON.stringify(candidate)}`,
      );
    }
  } finally {
    await fx.dispose();
  }
});

test('create rejects past or invalid expiry overrides', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);

    const past = await createInvite(fx, cookie, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      name: 'past',
    });
    expect(past.status, JSON.stringify(past)).toBe(422);
    expect(past.json.code).toBe('validation_error');

    const notADate = await createInvite(fx, cookie, {
      expiresAt: 'not-a-date',
      name: 'invalid',
    });
    expect(notADate.status, JSON.stringify(notADate)).toBe(422);
    expect(notADate.json.code).toBe('validation_error');

    const custom = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const ok = await createInvite(fx, cookie, {
      expiresAt: custom,
      name: 'custom',
    });
    expect(ok.status, JSON.stringify(ok)).toBe(201);
    expect((ok.json.data as { expiresAt: string }).expiresAt).toBe(custom);
  } finally {
    await fx.dispose();
  }
});

test('bootstrap mode: an unset STAFF_EMAILS gates sign-up by SETUP_TOKEN only', async () => {
  const fx = await startFixture({ staffEmails: null });
  try {
    // A fresh deployment accepts the bootstrap grant without consuming it.
    const grant = await fx.raw('/api/invites/validate', 'POST', {
      token: SETUP_TOKEN,
    });
    expect(grant.status, JSON.stringify(grant)).toBe(200);
    expect(grant.json).toEqual({ valid: true });

    // Sign-up succeeds without any allowlist entry.
    const cookie = await signUp(fx);

    // Once an account exists, the bootstrap grant is no longer available.
    expectUnavailable(
      await fx.raw('/api/invites/validate', 'POST', { token: SETUP_TOKEN }),
      'bootstrap grant after first account',
    );

    // A bootstrap-mode session reaches the invite management API.
    const list = await fx.raw('/v1/invites', 'GET', undefined, {
      Cookie: cookie,
    });
    expect(list.status).toBe(200);
    expect(list.json.data).toEqual([]);
  } finally {
    await fx.dispose();
  }
});

test('an explicitly empty STAFF_EMAILS still fails closed', async () => {
  const fx = await startFixture({ staffEmails: '' });
  try {
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
    expect(result.status, JSON.stringify(result)).toBe(403);
  } finally {
    await fx.dispose();
  }
});
