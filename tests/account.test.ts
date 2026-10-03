import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Self-service account management coverage.
 *
 * The worker runs in Miniflare in PRODUCTION mode (no DEV_ADMIN_EMAIL
 * bypass), so every route resolves a real Better Auth session from the
 * request cookie. Covered:
 *
 * - /v1/account/sessions requires a staff session, lists only the caller's
 *   live sessions, and never returns token material.
 * - Revoking another session kills that session's cookie; the current
 *   session cannot revoke itself; an unknown id is a 404.
 * - revoke-others keeps the current session alive and kills the rest.
 * - The /api/auth boundary validates name and password bodies before
 *   Better Auth runs (422 with the app error envelope, no write).
 * - A name change updates the session user and the staff list.
 * - A password change requires the current password, revokes every other
 *   session (old cookies die), and re-issues a fresh session cookie that
 *   still works; sign-in uses the new password afterwards.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Account tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

const SECRET = 'test-secret-test-secret-test-secret-12';
const ORIGIN = 'https://account-test.example';
const SETUP_TOKEN = 'test-invite-token'.padEnd(32, '!');

const workerScripts = new Map<string, string>();

const bundleWorker = async (): Promise<string> => {
  const cached = workerScripts.get('default');
  if (cached) {
    return cached;
  }

  await assertRepoRoot();
  const bundled = await build({
    bundle: true,
    conditions: ['workerd'],
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
    clientIp?: string,
  ) => Promise<RawResult>;
};

type RawResult = {
  cookie: string;
  json: Record<string, unknown>;
  status: number;
};

const startFixture = async (): Promise<Fixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        BETTER_AUTH_SECRET: SECRET,
        ENVIRONMENT: 'production',
        SETUP_TOKEN,
      },
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
      clientIp = '203.0.113.10',
    ): Promise<RawResult> => {
      const response = await mf.dispatchFetch(`${ORIGIN}${path}`, {
        headers: {
          'cf-connecting-ip': clientIp,
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

    return { db: database, dispose, raw };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const INITIAL_PASSWORD = 'correct-horse-battery';

/**
 * Creates the bootstrap admin plus one second session for the same account
 * (a second sign-in), so "other sessions" are real.
 */
const startSignedInFixture = async (): Promise<{
  adminCookie: string;
  adminUserId: string;
  fx: Fixture;
  otherCookie: string;
}> => {
  const fx = await startFixture();
  try {
    const signUp = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: INITIAL_PASSWORD,
      },
      { 'X-Setup-Token': SETUP_TOKEN },
      // Sign-up performs a server-side sign-in under the same client IP,
      // so keep each sign-in rate-limit bucket at one request.
      '203.0.113.10',
    );
    expect(signUp.status, JSON.stringify(signUp)).toBe(200);
    expect(signUp.cookie).not.toBe('');

    const secondSignIn = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      {
        email: 'admin@example.test',
        password: INITIAL_PASSWORD,
      },
      {},
      '203.0.113.11',
    );
    expect(secondSignIn.status, JSON.stringify(secondSignIn)).toBe(200);
    expect(secondSignIn.cookie).not.toBe('');
    expect(secondSignIn.cookie).not.toBe(signUp.cookie);

    const row = await fx.db
      .prepare('SELECT id FROM user WHERE email = ?')
      .bind('admin@example.test')
      .first<{ id: string }>();
    expect(row?.id, 'admin user row must exist').toBeTruthy();

    return {
      adminCookie: signUp.cookie,
      adminUserId: row ? row.id : '',
      fx,
      otherCookie: secondSignIn.cookie,
    };
  } catch (error) {
    await fx.dispose();
    throw error;
  }
};

type SessionRow = {
  createdAt: string;
  current: boolean;
  expiresAt: string;
  id: string;
  ipAddress: null | string;
  userAgent: null | string;
};

const listSessions = async (
  fx: Fixture,
  cookie: string,
): Promise<SessionRow[]> => {
  const result = await fx.raw('/v1/account/sessions', 'GET', undefined, {
    Cookie: cookie,
  });
  expect(result.status, JSON.stringify(result)).toBe(200);
  return result.json.data as SessionRow[];
};

test('account session routes require an authenticated staff session', async () => {
  const fx = await startFixture();
  try {
    for (const [path, method] of [
      ['/v1/account/sessions', 'GET'],
      ['/v1/account/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAX', 'DELETE'],
      ['/v1/account/sessions/revoke-others', 'POST'],
    ] as const) {
      const result = await fx.raw(path, method);
      expect(result.status, `${method} ${path}`).toBe(401);
      expect(result.json.code, `${method} ${path}`).toBe('unauthorized');
    }
  } finally {
    await fx.dispose();
  }
});

test('the session list shows only the caller, never token material', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const rows = await listSessions(fx, signedIn.adminCookie);
    expect(rows).toHaveLength(2);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain(INITIAL_PASSWORD);

    const sessionTokens = await fx.db
      .prepare('SELECT token FROM session')
      .all<{ token: string }>();
    for (const row of sessionTokens.results) {
      expect(serialized).not.toContain(row.token);
    }

    for (const row of rows) {
      expect(Object.keys(row).toSorted()).toEqual([
        'createdAt',
        'current',
        'expiresAt',
        'id',
        'ipAddress',
        'userAgent',
      ]);
    }

    expect(rows.filter((row) => row.current)).toHaveLength(1);
  } finally {
    await fx.dispose();
  }
});

test('revoking another session kills its cookie; self-revoke is refused', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const rows = await listSessions(fx, signedIn.adminCookie);
    const current = rows.find((row) => row.current);
    const other = rows.find((row) => !row.current);
    expect(current).toBeDefined();
    expect(other).toBeDefined();

    // The other session is alive before the revocation.
    const aliveBefore = await fx.raw('/v1/account/sessions', 'GET', undefined, {
      Cookie: signedIn.otherCookie,
    });
    expect(aliveBefore.status).toBe(200);

    const revoked = await fx.raw(
      `/v1/account/sessions/${other?.id}`,
      'DELETE',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(revoked.status, JSON.stringify(revoked)).toBe(204);

    // The other session's cookie no longer authorizes anything.
    const deadAfter = await fx.raw('/v1/account/sessions', 'GET', undefined, {
      Cookie: signedIn.otherCookie,
    });
    expect(deadAfter.status).toBe(401);

    // The current session still works.
    const stillAlive = await listSessions(fx, signedIn.adminCookie);
    expect(stillAlive).toHaveLength(1);
    expect(stillAlive[0]?.id).toBe(current?.id);

    // The current session cannot revoke itself.
    const selfRevoke = await fx.raw(
      `/v1/account/sessions/${current?.id}`,
      'DELETE',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(selfRevoke.status, JSON.stringify(selfRevoke)).toBe(409);
    expect(selfRevoke.json.code).toBe('conflict');

    // An unknown id is a 404, not a 204.
    const unknown = await fx.raw(
      '/v1/account/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAX',
      'DELETE',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.json.code).toBe('not_found');
  } finally {
    await fx.dispose();
  }
});

test('revoke-others keeps the current session and kills the rest', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const result = await fx.raw(
      '/v1/account/sessions/revoke-others',
      'POST',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.json.data).toEqual({ revoked: 1 });

    const remaining = await listSessions(fx, signedIn.adminCookie);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.current).toBe(true);

    const deadOther = await fx.raw('/v1/account/sessions', 'GET', undefined, {
      Cookie: signedIn.otherCookie,
    });
    expect(deadOther.status).toBe(401);
  } finally {
    await fx.dispose();
  }
});

test('the name update boundary validates before Better Auth runs', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const header = { Cookie: signedIn.adminCookie };

    for (const body of [
      {},
      { name: '   ' },
      { name: 'x'.repeat(201) },
      { email: 'new@example.test', name: 'Renamed' },
      { image: 'https://avatar.example/x.png', name: 'Renamed' },
    ]) {
      const rejected = await fx.raw(
        '/api/auth/update-user',
        'POST',
        body,
        header,
      );
      expect(rejected.status, JSON.stringify({ body, rejected })).toBe(422);
      expect(rejected.json.code).toBe('validation_error');
    }

    const updated = await fx.raw(
      '/api/auth/update-user',
      'POST',
      { name: '  Renamed Admin  ' },
      header,
    );
    expect(updated.status, JSON.stringify(updated)).toBe(200);

    const session = await fx.raw('/api/auth/get-session', 'GET', undefined, {
      Cookie: signedIn.adminCookie,
    });
    expect(session.status).toBe(200);
    const user = session.json.user as { name: string };
    expect(user.name).toBe('Renamed Admin');

    const staff = await fx.raw('/v1/staff', 'GET', undefined, {
      Cookie: signedIn.adminCookie,
    });
    const rows = staff.json.data as Array<{ id: string; name: string }>;
    expect(rows.find((row) => row.id === signedIn.adminUserId)?.name).toBe(
      'Renamed Admin',
    );

    const stored = await fx.db
      .prepare('SELECT name FROM user WHERE id = ?')
      .bind(signedIn.adminUserId)
      .first<{ name: string }>();
    expect(stored?.name).toBe('Renamed Admin');
  } finally {
    await fx.dispose();
  }
});

test('the password boundary validates lengths before Better Auth runs', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const header = { Cookie: signedIn.adminCookie };

    for (const [index, body] of [
      { newPassword: 'long-enough-password' },
      { currentPassword: INITIAL_PASSWORD },
      { currentPassword: '', newPassword: 'long-enough-password' },
      { currentPassword: INITIAL_PASSWORD, newPassword: 'short' },
      {
        currentPassword: INITIAL_PASSWORD,
        newPassword: 'x'.repeat(256),
      },
      { currentPassword: INITIAL_PASSWORD, newPassword: '   ' },
    ].entries()) {
      const rejected = await fx.raw(
        '/api/auth/change-password',
        'POST',
        body,
        header,
        // Rejected before Better Auth, so its 3-per-10s limiter never
        // fires — but spread IPs anyway so a boundary regression fails on
        // the 422 assertion, not on a confusing 429.
        `198.51.100.${20 + index}`,
      );
      expect(rejected.status, JSON.stringify({ body, rejected })).toBe(422);
      expect(rejected.json.code).toBe('validation_error');
    }

    // No validation rejection wrote anything: the password still works.
    const unchanged = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      {
        email: 'admin@example.test',
        password: INITIAL_PASSWORD,
      },
      {},
      '198.51.100.30',
    );
    expect(unchanged.status).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('a wrong current password is rejected without revoking sessions', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const result = await fx.raw(
      '/api/auth/change-password',
      'POST',
      {
        currentPassword: 'wrong-horse-battery',
        newPassword: 'new-password-123',
      },
      { Cookie: signedIn.adminCookie },
    );
    expect(result.status, JSON.stringify(result)).toBe(400);

    // Better Auth rejected the change: no session was revoked.
    const rows = await listSessions(fx, signedIn.adminCookie);
    expect(rows).toHaveLength(2);
    const otherStillAlive = await fx.raw(
      '/v1/account/sessions',
      'GET',
      undefined,
      { Cookie: signedIn.otherCookie },
    );
    expect(otherStillAlive.status).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('changing the password revokes other sessions and re-issues the caller', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const changed = await fx.raw(
      '/api/auth/change-password',
      'POST',
      { currentPassword: INITIAL_PASSWORD, newPassword: 'new-password-123' },
      { Cookie: signedIn.adminCookie },
    );
    expect(changed.status, JSON.stringify(changed)).toBe(200);
    // The response re-issues the session cookie for the caller.
    expect(changed.cookie).not.toBe('');

    // The other device's cookie is dead.
    const otherDead = await fx.raw('/v1/account/sessions', 'GET', undefined, {
      Cookie: signedIn.otherCookie,
    });
    expect(otherDead.status).toBe(401);

    // The caller's old cookie was replaced by the re-issued one.
    const oldCookieDead = await fx.raw(
      '/v1/account/sessions',
      'GET',
      undefined,
      { Cookie: signedIn.adminCookie },
    );
    expect(oldCookieDead.status).toBe(401);

    // The new cookie works and is the only remaining session.
    const fresh = await listSessions(fx, changed.cookie);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.current).toBe(true);

    // The old password no longer signs in; the new one does. Both use a
    // dedicated client IP: the sign-in limiter allows 3 per 10s and the
    // fixture already spent one on this IP's bucket during sign-up.
    const oldSignIn = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      {
        email: 'admin@example.test',
        password: INITIAL_PASSWORD,
      },
      {},
      '198.51.100.40',
    );
    expect(oldSignIn.status).toBe(401);
    const newSignIn = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      {
        email: 'admin@example.test',
        password: 'new-password-123',
      },
      {},
      '198.51.100.41',
    );
    expect(newSignIn.status).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('account routes reject untrusted origins for writes', async () => {
  const signedIn = await startSignedInFixture();
  const { fx } = signedIn;
  try {
    const rows = await listSessions(fx, signedIn.adminCookie);
    const other = rows.find((row) => !row.current);

    const hostile = await fx.raw(
      `/v1/account/sessions/${other?.id}`,
      'DELETE',
      undefined,
      { Cookie: signedIn.adminCookie, Origin: 'https://evil.example' },
    );
    expect(hostile.status, JSON.stringify(hostile)).toBe(403);
    expect(hostile.json.code).toBe('forbidden');

    const rowsAfter = await listSessions(fx, signedIn.adminCookie);
    expect(rowsAfter).toHaveLength(2);
  } finally {
    await fx.dispose();
  }
});
