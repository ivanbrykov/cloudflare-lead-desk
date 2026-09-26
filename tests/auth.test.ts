import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Auth coverage for the Better Auth email/password boundary.
 *
 * The worker runs in Miniflare in PRODUCTION mode (no DEV_ADMIN_EMAIL
 * bypass), so every protected route resolves a Better Auth session from the
 * request cookie. Registration is invitation-only: the X-Setup-Token header
 * must present the bootstrap SETUP_TOKEN grant (only while no account exists)
 * or a one-time staff invite, and every authenticated session reaches the API.
 * The fixture applies the real drizzle/ migrations, including the generated
 * Better Auth tables, against in-memory D1.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Auth tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

// Better Auth requires a sufficiently long secret; any fixed test value works.
const SECRET = 'test-secret-test-secret-test-secret-12';
const ORIGIN = 'https://auth-test.example';
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

type AuthFixture = {
  db: D1Database;
  dispose: () => Promise<void>;
  raw: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
    origin?: string,
  ) => Promise<RawResult>;
};

type FixtureOptions = {
  // null removes the binding from the fixture entirely.
  betterAuthSecret?: null | string;
  betterAuthUrl?: null | string;
  setupToken?: null | string;
};

type RawResult = {
  cookie: string;
  json: Record<string, unknown>;
  status: number;
};

const startFixture = async (
  options: FixtureOptions = {},
): Promise<AuthFixture> => {
  const script = await bundleWorker();
  const bindings: Record<string, string> = {
    ENVIRONMENT: 'production',
  };
  if (options.betterAuthSecret !== null) {
    bindings.BETTER_AUTH_SECRET = options.betterAuthSecret ?? SECRET;
  }

  if (options.betterAuthUrl !== null && options.betterAuthUrl !== undefined) {
    bindings.BETTER_AUTH_URL = options.betterAuthUrl;
  }

  if (options.setupToken !== null) {
    bindings.SETUP_TOKEN = options.setupToken ?? SETUP_TOKEN;
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
      origin = ORIGIN,
    ): Promise<RawResult> => {
      const response = await mf.dispatchFetch(`${origin}${path}`, {
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
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

const expectUnauthorized = (result: RawResult, label: string) => {
  expect(result.status, `${label}: ${JSON.stringify(result)}`).toBe(401);
  expect(result.json.code, `${label}: ${JSON.stringify(result)}`).toBe(
    'unauthorized',
  );
};

const expectRejectedSignUp = (result: RawResult, label: string) => {
  expect(result.status, `${label}: ${JSON.stringify(result)}`).toBe(403);
  expect(result.json.code, `${label}: ${JSON.stringify(result)}`).toBe(
    'invite_unavailable',
  );
  expect(result.cookie, `${label}: ${JSON.stringify(result)}`).toBe('');
};

const userCount = async (fx: AuthFixture): Promise<number> => {
  const row = await fx.db
    .prepare('SELECT count(*) AS count FROM user')
    .first<{ count: number }>();
  return row?.count ?? 0;
};

const signUp = async (
  fx: AuthFixture,
  email = 'admin@example.test',
  token: null | string = SETUP_TOKEN,
): Promise<string> => {
  const result = await fx.raw(
    '/api/auth/sign-up/email',
    'POST',
    {
      email,
      name: 'Test Admin',
      password: 'correct-horse-battery',
    },
    {
      ...(token === null ? {} : { 'X-Setup-Token': token }),
    },
  );
  expect(result.status, JSON.stringify(result)).toBe(200);
  expect(result.cookie).not.toBe('');
  return result.cookie;
};

test('an unauthenticated request is rejected with 401', async () => {
  const fx = await startFixture();
  try {
    expectUnauthorized(await fx.raw('/v1/contacts'), 'unauthenticated');
  } finally {
    await fx.dispose();
  }
});

test('an unexpected session lookup failure is a generic 500, not a 401', async () => {
  const fx = await startFixture();
  try {
    // A valid session cookie, then the session table disappears: this is a
    // D1 fault mid-lookup, not proof of an invalid session.
    const cookie = await signUp(fx);
    await fx.db.prepare('DROP TABLE session').run();
    const result = await fx.raw('/v1/contacts', 'GET', undefined, {
      Cookie: cookie,
    });
    expect(result.status, JSON.stringify(result)).toBe(500);
    expect(result.json.code, JSON.stringify(result)).toBe(
      'authentication_unavailable',
    );
    expect(result.json.message, JSON.stringify(result)).toBe(
      'Authentication could not be checked. Please try again.',
    );
  } finally {
    await fx.dispose();
  }
});

test('protected reads validate without refreshing; the auth endpoint can still refresh', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const expiresAt = Date.now() + 5 * 24 * 60 * 60 * 1_000;
    await fx.db
      .prepare('UPDATE session SET expires_at = ?')
      .bind(expiresAt)
      .run();

    const protectedRead = await fx.raw('/v1/opportunities', 'GET', undefined, {
      Cookie: cookie,
    });
    expect(protectedRead.status, JSON.stringify(protectedRead)).toBe(200);
    const unchanged = await fx.db
      .prepare('SELECT expires_at AS expiresAt FROM session')
      .first<{ expiresAt: number }>();
    expect(unchanged?.expiresAt).toBe(expiresAt);

    const browserSession = await fx.raw(
      '/api/auth/get-session',
      'GET',
      undefined,
      { Cookie: cookie },
    );
    expect(browserSession.status, JSON.stringify(browserSession)).toBe(200);
    expect(browserSession.cookie).not.toBe('');
    const refreshed = await fx.db
      .prepare('SELECT expires_at AS expiresAt FROM session')
      .first<{ expiresAt: number }>();
    expect(refreshed?.expiresAt).toBeGreaterThan(expiresAt);
  } finally {
    await fx.dispose();
  }
});

test('sign-up without an invite token is rejected and grants no access', async () => {
  const fx = await startFixture();
  try {
    const result = await fx.raw('/api/auth/sign-up/email', 'POST', {
      email: 'admin@example.test',
      name: 'Test Admin',
      password: 'correct-horse-battery',
    });
    expectRejectedSignUp(result, 'sign-up without token');
    expect(await userCount(fx), 'no user row may be written').toBe(0);
    expectUnauthorized(await fx.raw('/v1/contacts'), 'no token, no access');
  } finally {
    await fx.dispose();
  }
});

test('sign-up rejects a wrong invite token', async () => {
  const fx = await startFixture();
  try {
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': 'not-the-invite-token' },
    );
    expectRejectedSignUp(result, 'sign-up with wrong token');
    expect(await userCount(fx), 'no user row may be written').toBe(0);
  } finally {
    await fx.dispose();
  }
});

test('sign-up is rejected when SETUP_TOKEN is not configured', async () => {
  const fx = await startFixture({ setupToken: null });
  try {
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': 'any-token' },
    );
    expectRejectedSignUp(result, 'sign-up without SETUP_TOKEN binding');
    expect(await userCount(fx), 'no user row may be written').toBe(0);
  } finally {
    await fx.dispose();
  }
});

test('sign-up with the bootstrap token grants access to any email', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx, 'anyone@example.test');
    const contacts = await fx.raw('/v1/contacts', 'GET', undefined, { cookie });
    expect(contacts.status, JSON.stringify(contacts)).toBe(200);
    expect(Array.isArray(contacts.json.data)).toBe(true);
  } finally {
    await fx.dispose();
  }
});

test('the bootstrap grant is single-use: a second sign-up is rejected', async () => {
  const fx = await startFixture();
  try {
    await signUp(fx, 'first@example.test');
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'second@example.test',
        name: 'Second Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': SETUP_TOKEN },
    );
    expect(result.status, JSON.stringify(result)).toBe(403);
    expect(result.json.code, JSON.stringify(result)).toBe('invite_unavailable');
    expect(result.cookie, JSON.stringify(result)).toBe('');
    expect(await userCount(fx), 'no second user row is created').toBe(1);
  } finally {
    await fx.dispose();
  }
});

test('a duplicate email is rejected with 409 and leaves the invite usable', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx, 'first@example.test');
    const createInvite = async (name: string) => {
      const created = await fx.raw('/v1/invites', 'POST', { name }, { cookie });
      expect(created.status, JSON.stringify(created)).toBe(201);
      return (created.json.data as { token: string }).token;
    };

    const firstInvite = await createInvite('first invite');
    const secondInvite = await createInvite('second invite');

    const first = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'dup@example.test',
        name: 'Dup',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': firstInvite },
    );
    expect(first.status, JSON.stringify(first)).toBe(200);
    expect(first.cookie, JSON.stringify(first)).not.toBe('');

    const duplicate = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'dup@example.test',
        name: 'Dup Again',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': secondInvite },
    );
    expect(duplicate.status, JSON.stringify(duplicate)).toBe(409);
    expect(duplicate.json.code, JSON.stringify(duplicate)).toBe('email_exists');
    expect(duplicate.cookie, JSON.stringify(duplicate)).toBe('');
    expect(await userCount(fx), 'no duplicate user row').toBe(2);

    // The failed attempt rolled back: the second invite is still usable.
    const retry = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'fresh@example.test',
        name: 'Fresh',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': secondInvite },
    );
    expect(retry.status, JSON.stringify(retry)).toBe(200);
    expect(retry.cookie, JSON.stringify(retry)).not.toBe('');
  } finally {
    await fx.dispose();
  }
});

test('production infers the request origin for sign-up, sign-in, sessions, and API access', async () => {
  const fx = await startFixture({ betterAuthUrl: '   ' });
  try {
    const cookie = await signUp(fx);
    const signIn = await fx.raw('/api/auth/sign-in/email', 'POST', {
      email: 'admin@example.test',
      password: 'correct-horse-battery',
    });
    expect(signIn.status, JSON.stringify(signIn)).toBe(200);
    const session = await fx.raw('/api/auth/get-session', 'GET', undefined, {
      cookie,
    });
    expect(session.status, JSON.stringify(session)).toBe(200);
    expect(session.json.user).toMatchObject({ email: 'admin@example.test' });
    expect(
      (await fx.raw('/v1/contacts', 'GET', undefined, { cookie })).status,
    ).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('uses request.url instead of Origin, Host, or forwarded headers', async () => {
  const fx = await startFixture();
  try {
    const forwarded = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      {
        Host: 'attacker.example',
        'X-Forwarded-Host': 'attacker.example',
        'X-Forwarded-Proto': 'http',
        'X-Setup-Token': SETUP_TOKEN,
      },
    );
    expect(forwarded.status, JSON.stringify(forwarded)).toBe(200);

    const maliciousOrigin = await fx.raw(
      '/api/auth/sign-out',
      'POST',
      {},
      { cookie: forwarded.cookie, Origin: 'https://attacker.example' },
    );
    expect(maliciousOrigin.status, JSON.stringify(maliciousOrigin)).toBe(403);

    const maliciousCallback = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        callbackURL: 'https://attacker.example/steal-session',
        email: 'second@example.test',
        name: 'Second Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': SETUP_TOKEN },
    );
    expect(maliciousCallback.status, JSON.stringify(maliciousCallback)).toBe(
      403,
    );
    expect(maliciousCallback.json.code).toBe('forbidden');
    expect(await userCount(fx)).toBe(1);
  } finally {
    await fx.dispose();
  }
});

test('does not retain an inferred origin between sequential requests', async () => {
  const fx = await startFixture();
  const firstOrigin = 'https://first-origin.example';
  const secondOrigin = 'https://second-origin.example';
  try {
    const first = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': SETUP_TOKEN },
      firstOrigin,
    );
    expect(first.status, JSON.stringify(first)).toBe(200);

    const second = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      { email: 'admin@example.test', password: 'correct-horse-battery' },
      {},
      secondOrigin,
    );
    expect(second.status, JSON.stringify(second)).toBe(200);

    const staleOrigin = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      { email: 'admin@example.test', password: 'correct-horse-battery' },
      { Origin: firstOrigin },
      secondOrigin,
    );
    expect(staleOrigin.status, JSON.stringify(staleOrigin)).toBe(403);
  } finally {
    await fx.dispose();
  }
});

test('uses a valid BETTER_AUTH_URL override as the exact trusted origin', async () => {
  const override = 'https://canonical-auth.example';
  const fx = await startFixture({ betterAuthUrl: override });
  try {
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { Origin: override, 'X-Setup-Token': SETUP_TOKEN },
      'https://routed-worker.example',
    );
    expect(result.status, JSON.stringify(result)).toBe(200);

    const inferredOrigin = await fx.raw(
      '/api/auth/sign-in/email',
      'POST',
      { email: 'admin@example.test', password: 'correct-horse-battery' },
      {},
      'https://routed-worker.example',
    );
    expect(inferredOrigin.status, JSON.stringify(inferredOrigin)).toBe(403);
  } finally {
    await fx.dispose();
  }
});

test('sign-up with invalid fields is rejected with 422 and consumes no grant', async () => {
  const fx = await startFixture();
  try {
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'short',
      },
      { 'X-Setup-Token': SETUP_TOKEN },
    );
    expect(result.status, JSON.stringify(result)).toBe(422);
    expect(result.json.code, JSON.stringify(result)).toBe('validation_error');
    expect(result.cookie, JSON.stringify(result)).toBe('');
    expect(await userCount(fx), 'no user row may be written').toBe(0);

    // The bootstrap grant is still available after the failed attempt.
    expect((await signUp(fx)).length).toBeGreaterThan(0);
  } finally {
    await fx.dispose();
  }
});

test('a hostile Origin header is rejected before any grant is consumed', async () => {
  const fx = await startFixture();
  try {
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { Origin: 'https://attacker.example', 'X-Setup-Token': SETUP_TOKEN },
    );
    expect(result.status, JSON.stringify(result)).toBe(403);
    expect(result.json.code, JSON.stringify(result)).toBe('forbidden');
    expect(result.cookie, JSON.stringify(result)).toBe('');
    expect(await userCount(fx), 'no user row may be written').toBe(0);

    // The bootstrap grant is still available after the failed attempt.
    expect((await signUp(fx)).length).toBeGreaterThan(0);
  } finally {
    await fx.dispose();
  }
});

test('an external callbackURL is rejected before any grant is consumed', async () => {
  const fx = await startFixture();
  try {
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        callbackURL: 'https://attacker.example/steal-session',
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': SETUP_TOKEN },
    );
    expect(result.status, JSON.stringify(result)).toBe(403);
    expect(result.json.code, JSON.stringify(result)).toBe('forbidden');
    expect(result.cookie, JSON.stringify(result)).toBe('');
    expect(await userCount(fx), 'no user row may be written').toBe(0);

    // The bootstrap grant is still available after the failed attempt.
    expect((await signUp(fx)).length).toBeGreaterThan(0);
  } finally {
    await fx.dispose();
  }
});

test.each([
  ['trailing slash', '/api/auth/sign-up/email/'],
  ['dot segment', '/api/auth/sign-up/email/.'],
])('sign-up path aliases (%s) never create an account', async (_, path) => {
  const fx = await startFixture();
  try {
    const result = await fx.raw(
      path,
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': SETUP_TOKEN },
    );
    expect(result.status, JSON.stringify(result)).toBeGreaterThanOrEqual(400);
    expect(result.status, JSON.stringify(result)).toBeLessThan(500);
    expect(result.cookie, JSON.stringify(result)).toBe('');
    expect(await userCount(fx), 'no user row may be written').toBe(0);
  } finally {
    await fx.dispose();
  }
});

test('concurrent sign-ups against one invite settle to exactly one account', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx, 'owner@example.test');
    const created = await fx.raw(
      '/v1/invites',
      'POST',
      { name: 'race invite' },
      { cookie },
    );
    expect(created.status, JSON.stringify(created)).toBe(201);
    const token = (created.json.data as { token: string }).token;

    const attempt = (email: string, name: string) =>
      fx.raw(
        '/api/auth/sign-up/email',
        'POST',
        { email, name, password: 'correct-horse-battery' },
        { 'X-Setup-Token': token },
      );
    const [first, second] = await Promise.all([
      attempt('race-a@example.test', 'Race A'),
      attempt('race-b@example.test', 'Race B'),
    ]);

    const successes = [first, second].filter(
      (result) => result.status === 200 && result.cookie !== '',
    );
    expect(
      successes.length,
      `${JSON.stringify(first)} | ${JSON.stringify(second)}`,
    ).toBe(1);
    const loser = first.status === 200 ? second : first;
    expect(loser.status, JSON.stringify(loser)).toBe(403);
    expect(loser.json.code, JSON.stringify(loser)).toBe('invite_unavailable');
    expect(await userCount(fx), 'exactly one account is created').toBe(2);
  } finally {
    await fx.dispose();
  }
});

test.each([
  [
    'invalid override',
    { betterAuthUrl: 'https://worker.example/not-an-origin' },
  ],
  ['HTTP request origin', {}],
  ['missing secret', { betterAuthSecret: null }],
  ['short secret', { betterAuthSecret: 'too-short' }],
  [
    'placeholder secret',
    { betterAuthSecret: 'replace-with-openssl-rand-base64-32' },
  ],
])(
  'production %s fails closed for auth and session API calls',
  async (_, options) => {
    const fx = await startFixture(options);
    const origin =
      _ === 'HTTP request origin' ? 'http://worker.example' : ORIGIN;
    try {
      const signUpResult = await fx.raw(
        '/api/auth/sign-up/email',
        'POST',
        {
          email: 'admin@example.test',
          name: 'Test Admin',
          password: 'correct-horse-battery',
        },
        { 'X-Setup-Token': SETUP_TOKEN },
        origin,
      );
      const signIn = await fx.raw(
        '/api/auth/sign-in/email',
        'POST',
        { email: 'admin@example.test', password: 'correct-horse-battery' },
        {},
        origin,
      );
      const session = await fx.raw(
        '/api/auth/get-session',
        'GET',
        undefined,
        {},
        origin,
      );
      const api = await fx.raw('/v1/contacts', 'GET', undefined, {}, origin);
      for (const result of [signUpResult, signIn, session, api]) {
        expect(result.status, JSON.stringify(result)).toBe(503);
        expect(result.json.code, JSON.stringify(result)).toBe(
          'authentication_not_configured',
        );
      }

      expect(await userCount(fx)).toBe(0);
    } finally {
      await fx.dispose();
    }
  },
);

test.each(['x'.repeat(31), ` ${'x'.repeat(31)} `])(
  'production rejects a setup token below 32 trimmed characters: %j',
  async (setupToken) => {
    const fx = await startFixture({ setupToken });
    try {
      const result = await fx.raw(
        '/api/auth/sign-up/email',
        'POST',
        {
          email: 'admin@example.test',
          name: 'Test Admin',
          password: 'correct-horse-battery',
        },
        { 'X-Setup-Token': setupToken },
      );
      expectRejectedSignUp(result, 'short invite token');
      expect(await userCount(fx)).toBe(0);
      // A weak invite token closes registration, not the other auth endpoints.
      const signIn = await fx.raw('/api/auth/sign-in/email', 'POST', {
        email: 'admin@example.test',
        password: 'correct-horse-battery',
      });
      expect(signIn.status).toBe(401);
      expect(signIn.json.code).toBe('INVALID_EMAIL_OR_PASSWORD');
      expect((await fx.raw('/api/auth/get-session')).status).toBe(200);
    } finally {
      await fx.dispose();
    }
  },
);

test('production still requires an exact match for a 32-character setup token', async () => {
  const fx = await startFixture();
  try {
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': 'x'.repeat(32) },
    );
    expectRejectedSignUp(result, 'different 32-character invite token');
    expect(await userCount(fx)).toBe(0);
    await signUp(fx);
  } finally {
    await fx.dispose();
  }
});

test('the documented SETUP_TOKEN placeholder cannot register an account in production', async () => {
  const fx = await startFixture({
    setupToken: 'replace-with-openssl-rand-hex-32',
  });
  try {
    const result = await fx.raw(
      '/api/auth/sign-up/email',
      'POST',
      {
        email: 'admin@example.test',
        name: 'Test Admin',
        password: 'correct-horse-battery',
      },
      { 'X-Setup-Token': 'replace-with-openssl-rand-hex-32' },
    );
    expectRejectedSignUp(result, 'placeholder invite token');
    expect(await userCount(fx)).toBe(0);
  } finally {
    await fx.dispose();
  }
});

test('sign-in rejects a wrong password and accepts the right one', async () => {
  const fx = await startFixture();
  try {
    await signUp(fx);
    const wrong = await fx.raw('/api/auth/sign-in/email', 'POST', {
      email: 'admin@example.test',
      password: 'not-the-password',
    });
    expect(wrong.status, JSON.stringify(wrong)).toBe(401);

    const right = await fx.raw('/api/auth/sign-in/email', 'POST', {
      email: 'admin@example.test',
      password: 'correct-horse-battery',
    });
    expect(right.status, JSON.stringify(right)).toBe(200);
    expect(right.cookie).not.toBe('');
  } finally {
    await fx.dispose();
  }
});

test('intake bearer tokens are unaffected by the session boundary', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const created = await fx.raw(
      '/v1/tokens',
      'POST',
      { name: 'intake' },
      { cookie },
    );
    expect(created.status, JSON.stringify(created)).toBe(201);
    const { token } = created.json.data as { token: string };

    const payload = {
      email: 'intake-auth@example.test',
      name: 'Inquiry',
      source: 'website_form',
    };
    const intake = (authorization: null | string, key: string) =>
      fx.raw('/v1/intakes', 'POST', payload, {
        ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
        'Idempotency-Key': key,
      });

    expect((await intake(token, 'auth-first')).status).toBe(201);
    expectUnauthorized(
      await intake(null, 'auth-second'),
      'missing intake token',
    );
  } finally {
    await fx.dispose();
  }
});
