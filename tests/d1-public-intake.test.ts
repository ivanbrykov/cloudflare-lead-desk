import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * D1-backed tests for public intake tokens:
 *
 * - public tokens are stored verbatim so they can be copied again, while
 *   private tokens stay hash-only;
 * - `POST /v1/public/intakes/:token` creates a lead without a session and
 *   records provenance (origin + public key id);
 * - the two token classes cannot be used on each other's endpoint;
 * - revoking a public token stops it;
 * - the public route answers CORS preflight for browser posts.
 */

const repoRoot = process.cwd();

const workerScripts = new Map<string, string>();

const bundleWorker = async (): Promise<string> => {
  const cached = workerScripts.get('default');
  if (cached) {
    return cached;
  }

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

type PublicFixture = {
  db: D1Database;
  dispose: () => Promise<void>;
  request: (
    path: string,
    init?: {
      body?: unknown;
      headers?: Record<string, string>;
      method?: string;
    },
  ) => Promise<Response>;
};

const startFixture = async (): Promise<PublicFixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        DEV_ADMIN_EMAIL: 'public-intake@example.test',
        ENVIRONMENT: 'test',
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

    return {
      db: database,
      dispose,
      request: (path, init = {}) =>
        mf.dispatchFetch(`https://public-intake.example${path}`, {
          headers: {
            'Content-Type': 'application/json',
            ...init.headers,
          },
          method: init.method ?? 'POST',
          ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        }) as unknown as Promise<Response>,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const createToken = async (
  fx: PublicFixture,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await fx.request('/v1/tokens', { body });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
};

test('public tokens are stored for copying while private tokens stay hidden', async () => {
  const fx = await startFixture();
  try {
    const publicToken = await createToken(fx, {
      name: 'Website',
      type: 'browser',
    });
    expect(String(publicToken.token)).toMatch(/^lsc_pub_[0-9a-f]{64}$/u);
    expect(publicToken.scope).toBe('intake:write');

    const privateToken = await createToken(fx, { name: 'Server' });
    expect(String(privateToken.token)).toMatch(/^lsc_[0-9a-f]{64}$/u);

    const list = await fx.request('/v1/tokens', { method: 'GET' });
    expect(list.status).toBe(200);
    const rows = (
      (await list.json()) as { data: Array<Record<string, unknown>> }
    ).data;
    const publicRow = rows.find((row) => row.id === publicToken.id);
    const privateRow = rows.find((row) => row.id === privateToken.id);
    expect(publicRow?.token).toBe(publicToken.token);
    expect(publicRow?.type).toBe('browser');
    expect(privateRow?.token).toBeNull();
    expect(privateRow?.type).toBe('api');
    expect(JSON.stringify(rows)).not.toContain('token_hash');
  } finally {
    await fx.dispose();
  }
});

test('a public token creates a lead with provenance and no session', async () => {
  const fx = await startFixture();
  try {
    const token = await createToken(fx, { name: 'Website', type: 'browser' });
    const response = await fx.request(`/v1/public/intakes/${token.token}`, {
      body: {
        customFields: { form: 'pricing', plan: 'pro' },
        email: 'browser@example.test',
        firstName: 'Browser',
        name: 'Pricing form',
        skippedFields: [
          { name: 'company', reason: 'unmarked' },
          { name: 'password', reason: 'sensitive' },
        ],
        source: 'website_form',
      },
      headers: {
        'Idempotency-Key': 'public-browser-1',
        Origin: 'https://ileo.test',
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toEqual({ data: { created: true } });

    const row = await fx.db
      .prepare(
        'SELECT custom_fields, id, origin, raw_payload, skipped_fields, token_id FROM leads WHERE email = ?',
      )
      .bind('browser@example.test')
      .first<{
        custom_fields: string;
        id: string;
        origin: string;
        raw_payload: string;
        skipped_fields: string;
        token_id: string;
      }>();
    expect(row).toMatchObject({
      origin: 'https://ileo.test',
      token_id: token.id,
    });
    expect(JSON.parse(String(row?.custom_fields))).toEqual({
      form: 'pricing',
      plan: 'pro',
    });
    // The contract ignores unknown fields, but the raw payload keeps them.
    expect(JSON.parse(String(row?.raw_payload))).toMatchObject({
      name: 'Pricing form',
      source: 'website_form',
    });
    expect(JSON.parse(String(row?.skipped_fields))).toEqual([
      { name: 'company', reason: 'unmarked' },
      { name: 'password', reason: 'sensitive' },
    ]);

    const detail = await fx.request(`/v1/leads/${String(row?.id)}`, {
      method: 'GET',
    });
    expect(detail.status, await detail.clone().text()).toBe(200);
    const detailJson = (await detail.json()) as {
      data: Record<string, unknown>;
    };
    expect(detailJson.data['tokenId']).toBe(token.id);
    expect(detailJson.data['tokenType']).toBe('browser');
    expect(detailJson.data['tokenName']).toBe('Website');
    expect(detailJson.data['rawPayload']).toMatchObject({
      name: 'Pricing form',
    });
    expect(detailJson.data['skippedFields']).toEqual([
      { name: 'company', reason: 'unmarked' },
      { name: 'password', reason: 'sensitive' },
    ]);

    // The public token cannot call the private intake route.
    const privateRoute = await fx.request('/v1/intakes', {
      body: { email: 'x@example.test', source: 'website_form' },
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Idempotency-Key': 'public-on-private',
      },
    });
    expect(privateRoute.status).toBe(401);
  } finally {
    await fx.dispose();
  }
});

test('a private token cannot use the public route, and revocation stops public tokens', async () => {
  const fx = await startFixture();
  try {
    const privateToken = await createToken(fx, { name: 'Server' });
    const rejected = await fx.request(
      `/v1/public/intakes/${privateToken.token}`,
      {
        body: { email: 'nope@example.test', source: 'website_form' },
      },
    );
    expect(rejected.status).toBe(401);

    const publicToken = await createToken(fx, {
      name: 'Website',
      type: 'browser',
    });
    const revoke = await fx.request(`/v1/tokens/${publicToken.id}`, {
      method: 'DELETE',
    });
    expect(revoke.status).toBe(204);
    const afterRevoke = await fx.request(
      `/v1/public/intakes/${publicToken.token}`,
      {
        body: { email: 'revoked@example.test', source: 'website_form' },
        headers: { 'Idempotency-Key': 'revoked-key' },
      },
    );
    expect(afterRevoke.status).toBe(401);
    expect(
      await fx.db
        .prepare('SELECT count(*) AS count FROM leads WHERE email = ?')
        .bind('revoked@example.test')
        .first(),
    ).toEqual({ count: 0 });
  } finally {
    await fx.dispose();
  }
});

test('the public route answers CORS preflight and marks responses', async () => {
  const fx = await startFixture();
  try {
    const token = await createToken(fx, { name: 'Website', type: 'browser' });
    const preflight = await fx.request(`/v1/public/intakes/${token.token}`, {
      headers: {
        'Access-Control-Request-Headers': 'content-type,idempotency-key',
        'Access-Control-Request-Method': 'POST',
        Origin: 'https://ileo.test',
      },
      method: 'OPTIONS',
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(
      preflight.headers.get('access-control-allow-credentials'),
    ).toBeNull();
    expect(preflight.headers.get('access-control-allow-methods')).toContain(
      'POST',
    );
    expect(
      preflight.headers.get('access-control-allow-headers')?.toLowerCase(),
    ).toContain('idempotency-key');

    const post = await fx.request(`/v1/public/intakes/${token.token}`, {
      body: { email: 'cors@example.test', source: 'website_form' },
      headers: { 'Idempotency-Key': 'cors-key', Origin: 'https://ileo.test' },
    });
    expect(post.status, await post.clone().text()).toBe(201);
    expect(post.headers.get('access-control-allow-origin')).toBe('*');
    expect(post.headers.get('access-control-allow-credentials')).toBeNull();
  } finally {
    await fx.dispose();
  }
});

test('CORS stays scoped to the public route', async () => {
  const fx = await startFixture();
  try {
    const response = await fx.request('/v1/leads', {
      headers: { Origin: 'https://evil.example' },
      method: 'GET',
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  } finally {
    await fx.dispose();
  }
});

test('browser idempotency keys cannot collide with API intake keys', async () => {
  const fx = await startFixture();
  try {
    const apiToken = await createToken(fx, { name: 'Server' });
    const browserToken = await createToken(fx, {
      name: 'Website',
      type: 'browser',
    });

    const api = await fx.request('/v1/intakes', {
      body: { email: 'api@example.test', source: 'server' },
      headers: {
        Authorization: `Bearer ${String(apiToken.token)}`,
        'Idempotency-Key': 'shared-key-1',
      },
    });
    expect(api.status, await api.clone().text()).toBe(201);

    const browser = await fx.request(
      `/v1/public/intakes/${String(browserToken.token)}`,
      {
        body: { email: 'browser@example.test', source: 'website_form' },
        headers: { 'Idempotency-Key': 'shared-key-1' },
      },
    );
    expect(browser.status, await browser.clone().text()).toBe(201);

    const row = await fx.db
      .prepare(
        "SELECT count(*) AS n FROM leads WHERE email IN ('api@example.test', 'browser@example.test')",
      )
      .first();
    expect(row?.n).toBe(2);
  } finally {
    await fx.dispose();
  }
});
