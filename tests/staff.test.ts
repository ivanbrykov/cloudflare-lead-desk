import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Regression coverage for staff account revocation (s5).
 *
 * The worker runs in Miniflare in PRODUCTION mode, so every protected
 * route resolves a Better Auth session from the request cookie. The
 * fixture applies the real drizzle/ migrations against in-memory D1.
 * Disabling an account writes the durable disabled flag and deletes all
 * of the account's session rows in one transaction; sign-in with a
 * disabled account's credentials is denied; re-enabling keeps the
 * credentials but never restores deleted sessions.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Staff tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

// Better Auth requires a sufficiently long secret; any fixed test value works.
const SECRET = 'test-secret-test-secret-test-secret-12';
const ORIGIN = 'https://staff-test.example';
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
          // Origin as a CSRF failure (403 MISSING_OR_NULL_ORIGIN); the
          // verifier fixture sets the origin itself, so the repo test must
          // send the trusted one explicitly.
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

/**
 * Signs up the bootstrap admin and one invited member; returns cookies.
 */
const startStaffedFixture = async (): Promise<{
  adminCookie: string;
  adminEmail: string;
  fx: Fixture;
  memberCookie: string;
  memberEmail: string;
  memberId: string;
  memberPassword: string;
}> => {
  const fx = await startFixture();
  try {
    const adminCookie = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': SETUP_TOKEN },
    );
    expect(adminCookie.status, JSON.stringify(adminCookie)).toBe(200);

    const created = await fx.raw(
      '/v1/invites',
      'POST',
      { name: 'Member' },
      {
        Cookie: adminCookie.cookie,
      },
    );
    expect(created.status, JSON.stringify(created)).toBe(201);
    const token = (created.json.data as { token: string }).token;

    const memberCookie = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'member@example.test',
        name: 'Test Member',
        password: 'fixture-password-123',
      },
      { 'X-Setup-Token': token },
    );
    expect(memberCookie.status, JSON.stringify(memberCookie)).toBe(200);

    const memberRow = await fx.db
      .prepare('SELECT id FROM user WHERE email = ?')
      .bind('member@example.test')
      .first<{ id: string }>();
    const memberId = memberRow ? memberRow.id : '';
    expect(memberId, 'member account row must exist').not.toBe('');

    return {
      adminCookie: adminCookie.cookie,
      adminEmail: 'admin@example.test',
      fx,
      memberCookie: memberCookie.cookie,
      memberEmail: 'member@example.test',
      memberId,
      memberPassword: 'fixture-password-123',
    };
  } catch (error) {
    await fx.dispose();
    throw error;
  }
};

const staffRecord = (result: RawResult) =>
  result.json.data as {
    disabledAt: null | string;
    email: string;
    id: string;
    name: string;
  };

test('staff management requires an authenticated staff session', async () => {
  const fx = await startFixture();
  try {
    for (const [path, method, body] of [
      ['/v1/staff', 'GET', undefined],
      ['/v1/staff/01ARZ3NDEKTSV4RRFFQ69G5FAX', 'PATCH', { disabled: true }],
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

test('disable revokes sessions durably; re-enable keeps credentials but not sessions', async () => {
  const staffed = await startStaffedFixture();
  const { fx } = staffed;
  try {
    // The list exposes only the public projection of both accounts.
    const list = await fx.raw('/v1/staff', 'GET', undefined, {
      Cookie: staffed.adminCookie,
    });
    expect(list.status, JSON.stringify(list)).toBe(200);
    const rows = list.json.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).toSorted()).toEqual([
        'disabledAt',
        'email',
        'id',
        'name',
      ]);
      expect(row.disabledAt).toBeNull();
    }

    const listText = JSON.stringify(list.json);
    expect(listText).not.toContain('correct-horse-battery');
    expect(listText).not.toContain('fixture-password-123');
    expect(listText.toLowerCase()).not.toContain('hash');

    // The member holds a live session before the revocation.
    const liveBefore = await fx.raw('/v1/tokens', 'GET', undefined, {
      Cookie: staffed.memberCookie,
    });
    expect(liveBefore.status).toBe(200);

    // Disable: the flag and the session deletion commit atomically.
    const disabled = await fx.raw(
      `/v1/staff/${staffed.memberId}`,
      'PATCH',
      { disabled: true },
      { Cookie: staffed.adminCookie },
    );
    expect(disabled.status, JSON.stringify(disabled)).toBe(200);
    const record = staffRecord(disabled);
    expect(record.email).toBe(staffed.memberEmail);
    const disabledAt = record.disabledAt;
    expect(typeof disabledAt, JSON.stringify(record)).toBe('string');
    expect(new Date(disabledAt as string).getTime()).not.toBeNaN();

    const sessions = await fx.db
      .prepare('SELECT count(*) AS n FROM session WHERE user_id = ?')
      .bind(staffed.memberId)
      .first<{ n: number }>();
    expect(sessions?.n, 'all member sessions must be deleted').toBe(0);

    // The stale session is rejected even though the cookie is intact.
    const stale = await fx.raw('/v1/tokens', 'GET', undefined, {
      Cookie: staffed.memberCookie,
    });
    expect(stale.status, JSON.stringify(stale)).toBe(401);
    expect(stale.json.code).toBe('unauthorized');

    // Sign-in with the account credentials is denied.
    const relogin = await fx.raw('/api/auth/sign-in/email', 'POST', {
      email: staffed.memberEmail,
      password: staffed.memberPassword,
    });
    expect(relogin.status).toBeGreaterThanOrEqual(400);
    expect(relogin.status).toBeLessThan(500);
    expect(relogin.json.code).toBe('account_disabled');

    // The durable state is visible in the list.
    const afterDisable = await fx.raw('/v1/staff', 'GET', undefined, {
      Cookie: staffed.adminCookie,
    });
    expect(afterDisable.status).toBe(200);
    const afterRows = afterDisable.json.data as Array<{
      disabledAt: null | string;
      email: string;
    }>;
    expect(afterRows.filter((entry) => entry.disabledAt === null).length).toBe(
      1,
    );

    // Re-enable: the flag clears, credentials work again, but the old
    // session row is never restored.
    const enabled = await fx.raw(
      `/v1/staff/${staffed.memberId}`,
      'PATCH',
      { disabled: false },
      { Cookie: staffed.adminCookie },
    );
    expect(enabled.status, JSON.stringify(enabled)).toBe(200);
    expect(staffRecord(enabled).disabledAt).toBeNull();
    expect(staffRecord(enabled).id).toBe(staffed.memberId);

    const staleAfterEnable = await fx.raw('/v1/tokens', 'GET', undefined, {
      Cookie: staffed.memberCookie,
    });
    expect(staleAfterEnable.status).toBe(401);
    expect(staleAfterEnable.json.code).toBe('unauthorized');

    const fresh = await fx.raw('/api/auth/sign-in/email', 'POST', {
      email: staffed.memberEmail,
      password: staffed.memberPassword,
    });
    expect(fresh.status, JSON.stringify(fresh)).toBe(200);
    expect(fresh.cookie).not.toBe('');
    const restored = await fx.raw('/v1/tokens', 'GET', undefined, {
      Cookie: fresh.cookie,
    });
    expect(restored.status).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('an account cannot disable itself, and neither can disable the last enabled account', async () => {
  const staffed = await startStaffedFixture();
  const { fx } = staffed;
  try {
    // Self-disable while both accounts are enabled.
    const memberSelf = await fx.raw(
      `/v1/staff/${staffed.memberId}`,
      'PATCH',
      { disabled: true },
      { Cookie: staffed.memberCookie },
    );
    expect(memberSelf.status, JSON.stringify(memberSelf)).toBe(409);

    const sessions = await fx.db
      .prepare('SELECT count(*) AS n FROM session WHERE user_id = ?')
      .bind(staffed.memberId)
      .first<{ n: number }>();
    expect(sessions?.n, 'failed self-disable must not touch sessions').toBe(1);
    const memberStillWorks = await fx.raw('/v1/tokens', 'GET', undefined, {
      Cookie: staffed.memberCookie,
    });
    expect(memberStillWorks.status).toBe(200);

    // The admin disables the member: only the admin stays enabled.
    const disabled = await fx.raw(
      `/v1/staff/${staffed.memberId}`,
      'PATCH',
      { disabled: true },
      { Cookie: staffed.adminCookie },
    );
    expect(disabled.status, JSON.stringify(disabled)).toBe(200);
    const adminRow = await fx.db
      .prepare('SELECT id FROM user WHERE email = ?')
      .bind(staffed.adminEmail)
      .first<{ id: string }>();
    const adminId = adminRow ? adminRow.id : '';
    expect(adminId, 'admin account row must exist').not.toBe('');
    const lastEnabled = await fx.raw(
      `/v1/staff/${adminId}`,
      'PATCH',
      { disabled: true },
      { Cookie: staffed.adminCookie },
    );
    expect(lastEnabled.status, JSON.stringify(lastEnabled)).toBe(409);

    // The admin remains usable afterwards.
    const adminAlive = await fx.raw('/v1/staff', 'GET', undefined, {
      Cookie: staffed.adminCookie,
    });
    expect(adminAlive.status).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('unknown staff ids return 404 and invalid bodies return 422', async () => {
  const staffed = await startStaffedFixture();
  const { fx } = staffed;
  try {
    const missing = await fx.raw(
      '/v1/staff/01ARZ3NDEKTSV4RRFFQ69G5FAX',
      'PATCH',
      { disabled: true },
      { Cookie: staffed.adminCookie },
    );
    expect(missing.status, JSON.stringify(missing)).toBe(404);
    expect(missing.json.code).toBe('not_found');

    for (const body of [{ disabled: 'yes' }, {}]) {
      const result = await fx.raw(
        `/v1/staff/${staffed.memberId}`,
        'PATCH',
        body,
        { Cookie: staffed.adminCookie },
      );
      expect(
        result.status,
        `PATCH ${JSON.stringify(body)}: ${JSON.stringify(result)}`,
      ).toBe(422);
      expect(result.json.code, JSON.stringify(body)).toBe('validation_error');
    }

    // The failed patches changed nothing.
    const list = await fx.raw('/v1/staff', 'GET', undefined, {
      Cookie: staffed.adminCookie,
    });
    expect(list.status).toBe(200);
    for (const row of list.json.data as Array<{ disabledAt: null | string }>) {
      expect(row.disabledAt).toBeNull();
    }
  } finally {
    await fx.dispose();
  }
});

test('setting the already-held state is an idempotent no-op', async () => {
  const staffed = await startStaffedFixture();
  const { fx } = staffed;
  try {
    // Already enabled: { disabled: false } is a 200 no-op.
    const noop = await fx.raw(
      `/v1/staff/${staffed.memberId}`,
      'PATCH',
      { disabled: false },
      { Cookie: staffed.adminCookie },
    );
    expect(noop.status, JSON.stringify(noop)).toBe(200);
    expect(staffRecord(noop).disabledAt).toBeNull();

    // Disable, then repeat: same flag value, no error.
    const disabled = await fx.raw(
      `/v1/staff/${staffed.memberId}`,
      'PATCH',
      { disabled: true },
      { Cookie: staffed.adminCookie },
    );
    expect(disabled.status).toBe(200);
    const firstFlag = staffRecord(disabled).disabledAt;

    const repeat = await fx.raw(
      `/v1/staff/${staffed.memberId}`,
      'PATCH',
      { disabled: true },
      { Cookie: staffed.adminCookie },
    );
    expect(repeat.status, JSON.stringify(repeat)).toBe(200);
    expect(staffRecord(repeat).disabledAt).toBe(firstFlag);

    // The member's sessions are still gone and re-enabling still works.
    const sessions = await fx.db
      .prepare('SELECT count(*) AS n FROM session WHERE user_id = ?')
      .bind(staffed.memberId)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const enabled = await fx.raw(
      `/v1/staff/${staffed.memberId}`,
      'PATCH',
      { disabled: false },
      { Cookie: staffed.adminCookie },
    );
    expect(enabled.status).toBe(200);
    expect(staffRecord(enabled).disabledAt).toBeNull();
  } finally {
    await fx.dispose();
  }
});
