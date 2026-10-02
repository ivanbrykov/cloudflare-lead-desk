import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Better Auth's rate limiter is enabled explicitly with database storage, so
 * the counters live in D1 instead of per-isolate memory. This fixture runs the
 * Worker in production mode — the limiter's default enablement depends on
 * NODE_ENV, which Workers does not set — and drives the sign-in endpoint, which
 * has a stricter built-in rule (3 attempts per 10 seconds) than the global
 * window.
 */

const repoRoot = process.cwd();
const SECRET = 'test-secret-test-secret-test-secret-12';
const ORIGIN = 'https://rate-limit-test.example';

const workerScripts = new Map<string, string>();

const bundleWorker = async (): Promise<string> => {
  const cached = workerScripts.get('default');
  if (cached) {
    return cached;
  }

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
  signIn: (
    ip: string,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
};

const startFixture = async (): Promise<Fixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        BETTER_AUTH_SECRET: SECRET,
        ENVIRONMENT: 'production',
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

    const signIn = async (
      ip: string,
    ): Promise<{ json: Record<string, unknown>; status: number }> => {
      const response = await mf.dispatchFetch(
        `${ORIGIN}/api/auth/sign-in/email`,
        {
          body: JSON.stringify({
            email: 'nobody@example.test',
            password: 'wrong-password',
          }),
          headers: {
            'cf-connecting-ip': ip,
            'Content-Type': 'application/json',
            Origin: ORIGIN,
          },
          method: 'POST',
        },
      );
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }

      return { json, status: response.status };
    };

    return { db: database, dispose, signIn };
  } catch (error) {
    await dispose();
    throw error;
  }
};

test('sign-in attempts are limited per client IP and stored in D1', async () => {
  const fx = await startFixture();
  try {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await fx.signIn('203.0.113.10')).status);
    }

    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);

    const rows = await fx.db
      .prepare('SELECT count, key FROM rate_limit')
      .all<{ count: number; key: string }>();
    expect(rows.results).toHaveLength(1);
    expect(Number(rows.results[0]?.count)).toBeGreaterThanOrEqual(3);
    expect(String(rows.results[0]?.key)).toContain('203.0.113.10');
  } finally {
    await fx.dispose();
  }
});

test('separate client IPs have separate buckets', async () => {
  const fx = await startFixture();
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await fx.signIn('203.0.113.20');
    }

    const blocked = await fx.signIn('203.0.113.20');
    expect(blocked.status).toBe(429);

    const otherClient = await fx.signIn('203.0.113.21');
    expect(otherClient.status).toBe(401);
  } finally {
    await fx.dispose();
  }
});

test('a blocked client is short-circuited without the database limiter', async () => {
  const fx = await startFixture();
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await fx.signIn('203.0.113.30');
    }

    expect((await fx.signIn('203.0.113.30')).status).toBe(429);

    // With the counter row gone, a database limiter call would allow the next
    // request (401). A 429 therefore proves the negative cache answered.
    await fx.db.prepare('DELETE FROM rate_limit').run();

    const cached = await fx.signIn('203.0.113.30');
    expect(cached.status).toBe(429);

    const otherClient = await fx.signIn('203.0.113.31');
    expect(otherClient.status).toBe(401);
  } finally {
    await fx.dispose();
  }
});

test('a blocked IPv6 client covers its /64 subnet', async () => {
  const fx = await startFixture();
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await fx.signIn('2001:db8:1:2::1');
    }

    expect((await fx.signIn('2001:db8:1:2::1')).status).toBe(429);

    // With the counter row gone, a negative-cache miss would let the database
    // limiter allow this address (401). Better Auth groups IPv6 by /64, so the
    // marker must cover another address in the same subnet while a different
    // subnet stays free.
    await fx.db.prepare('DELETE FROM rate_limit').run();

    const sameSubnet = await fx.signIn('2001:db8:1:2::9');
    expect(sameSubnet.status).toBe(429);

    const otherSubnet = await fx.signIn('2001:db8:1:3::9');
    expect(otherSubnet.status).toBe(401);
  } finally {
    await fx.dispose();
  }
});
