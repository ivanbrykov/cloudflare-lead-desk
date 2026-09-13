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
 * request cookie. The fixture applies the real drizzle/ migrations, including
 * the generated Better Auth tables, against in-memory D1.
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

type AuthFixture = {
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

const startFixture = async (
  options: { disableSignUp?: boolean } = {},
): Promise<AuthFixture> => {
  const script = await bundleWorker();
  const bindings: Record<string, string> = {
    BETTER_AUTH_SECRET: SECRET,
    ENVIRONMENT: 'production',
    ...(options.disableSignUp ? { DISABLE_SIGN_UP: 'true' } : {}),
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

const expectUnauthorized = (result: RawResult, label: string) => {
  expect(result.status, `${label}: ${JSON.stringify(result)}`).toBe(401);
  expect(result.json.code, `${label}: ${JSON.stringify(result)}`).toBe(
    'unauthorized',
  );
};

const signUp = async (
  fx: AuthFixture,
  email = 'admin@example.test',
): Promise<string> => {
  const result = await fx.raw('/api/auth/sign-up/email', 'POST', {
    email,
    name: 'Test Admin',
    password: 'correct-horse-battery',
  });
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

test('sign-up creates a session cookie that grants access', async () => {
  const fx = await startFixture();
  try {
    const cookie = await signUp(fx);
    const contacts = await fx.raw('/v1/contacts', 'GET', undefined, { cookie });
    expect(contacts.status, JSON.stringify(contacts)).toBe(200);
    expect(Array.isArray(contacts.json.data)).toBe(true);
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

test('DISABLE_SIGN_UP closes registration', async () => {
  const fx = await startFixture({ disableSignUp: true });
  try {
    const result = await fx.raw('/api/auth/sign-up/email', 'POST', {
      email: 'late@example.test',
      name: 'Late Arrival',
      password: 'correct-horse-battery',
    });
    expect(result.status, JSON.stringify(result)).toBeGreaterThanOrEqual(400);
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
      contact: { email: 'intake-auth@example.test' },
      opportunity: { name: 'Inquiry', source: 'form' },
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
