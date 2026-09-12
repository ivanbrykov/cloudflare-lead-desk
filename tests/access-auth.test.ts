import { build } from 'esbuild';
import * as jose from 'jose';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Auth negative coverage for Cloudflare Access verification.
 *
 * The worker runs in Miniflare in PRODUCTION mode (no DEV_ADMIN_EMAIL
 * bypass), so every protected route goes through `requireAccessIdentity`.
 * A jose-generated ES256 keypair stands in for the Access signing key: the
 * public half is served as a JWKS document through Miniflare's
 * `outboundService` option, which intercepts the worker's fetch of
 * `https://<team-domain>/cdn-cgi/access/certs`. No production-code seam is
 * involved. Every verification failure must map to 401 `{ code, message }`,
 * never 500.
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

const TEAM = 'test.cloudflareaccess.com';
const AUD = 'test-aud';

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

const jwksDocument = async (publicKey: CryptoKey) => {
  const jwk = (await jose.exportJWK(publicKey)) as jose.JWK;
  jwk.kid = 'k1';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  return { keys: [jwk] };
};

type AuthFixture = {
  db: D1Database;
  dispose: () => Promise<void>;
  raw: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  sign: (
    claims: Record<string, unknown>,
    overrides?: SignOverrides,
  ) => Promise<string>;
};

type SignOverrides = {
  aud?: string;
  iss?: string;
  key?: CryptoKey;
  kid?: string;
};

/**
 * Fresh in-memory D1 + worker fixture. `devAdmin` switches the fixture to
 * the development bypass (no JWT needed) for routes that only require an
 * intake token; otherwise the fixture runs in production mode with the
 * JWKS endpoint served (or failed) by the outbound service.
 */
const startFixture = async (
  options: { devAdmin?: string; jwksFails?: boolean } = {},
): Promise<AuthFixture> => {
  const script = await bundleWorker();
  const { privateKey, publicKey } = await jose.generateKeyPair('ES256', {
    extractable: true,
  });
  const outbound = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.hostname === TEAM && url.pathname === '/cdn-cgi/access/certs') {
      if (options.jwksFails) {
        return new Response('upstream JWKS unavailable', { status: 500 });
      }

      return Response.json(await jwksDocument(publicKey));
    }

    // Any other outbound call is a test defect; fail loudly.
    return new Response(`unexpected outbound ${request.url}`, { status: 502 });
  };

  const bindings: Record<string, string> = options.devAdmin
    ? {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: TEAM,
        DEV_ADMIN_EMAIL: options.devAdmin,
        ENVIRONMENT: 'test',
      }
    : {
        ACCESS_AUD: AUD,
        ACCESS_TEAM_DOMAIN: TEAM,
        ENVIRONMENT: 'production',
      };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings,
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      outboundService: outbound,
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
    ): Promise<{ json: Record<string, unknown>; status: number }> => {
      const response = await mf.dispatchFetch(
        `https://auth-test.example${path}`,
        {
          headers: { 'Content-Type': 'application/json', ...headers },
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

    const sign = (
      claims: Record<string, unknown>,
      overrides: SignOverrides = {},
    ): Promise<string> =>
      new jose.SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: overrides.kid ?? 'k1' })
        .setAudience(overrides.aud ?? AUD)
        .setIssuer(overrides.iss ?? `https://${TEAM}`)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(overrides.key ?? privateKey);
    return { db: database, dispose, raw, sign };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const expectUnauthorized = (
  result: { json: Record<string, unknown>; status: number },
  label: string,
) => {
  expect(result.status, `${label}: ${JSON.stringify(result)}`).toBe(401);
  expect(result.json.code, `${label}: ${JSON.stringify(result)}`).toBe(
    'unauthorized',
  );
  expect(typeof result.json.message).toBe('string');
};

test('a missing assertion header is rejected with 401', async () => {
  const fx = await startFixture();
  try {
    expectUnauthorized(await fx.raw('/v1/contacts'), 'missing header');
  } finally {
    await fx.dispose();
  }
});

test('a forged signature (key not in the JWKS) is rejected with 401', async () => {
  const fx = await startFixture();
  try {
    const { privateKey } = await jose.generateKeyPair('ES256', {
      extractable: true,
    });
    const token = await fx.sign(
      { email: 'forger@example.test' },
      { key: privateKey },
    );
    expectUnauthorized(
      await fx.raw('/v1/contacts', 'GET', undefined, {
        'Cf-Access-Jwt-Assertion': token,
      }),
      'forged signature',
    );
  } finally {
    await fx.dispose();
  }
});

test('a wrong audience is rejected with 401', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.sign({ email: 'a@b.test' }, { aud: 'other-aud' });
    expectUnauthorized(
      await fx.raw('/v1/contacts', 'GET', undefined, {
        'Cf-Access-Jwt-Assertion': token,
      }),
      'wrong audience',
    );
  } finally {
    await fx.dispose();
  }
});

test('a wrong issuer is rejected with 401', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.sign(
      { email: 'a@b.test' },
      { iss: 'https://evil.example.com' },
    );
    expectUnauthorized(
      await fx.raw('/v1/contacts', 'GET', undefined, {
        'Cf-Access-Jwt-Assertion': token,
      }),
      'wrong issuer',
    );
  } finally {
    await fx.dispose();
  }
});

test('a token without an email claim is rejected with 401', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.sign({ sub: 'no-email' });
    expectUnauthorized(
      await fx.raw('/v1/contacts', 'GET', undefined, {
        'Cf-Access-Jwt-Assertion': token,
      }),
      'missing email',
    );
  } finally {
    await fx.dispose();
  }
});

test('an unknown key id is rejected with 401', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.sign({ email: 'a@b.test' }, { kid: 'unknown-kid' });
    expectUnauthorized(
      await fx.raw('/v1/contacts', 'GET', undefined, {
        'Cf-Access-Jwt-Assertion': token,
      }),
      'unknown kid',
    );
  } finally {
    await fx.dispose();
  }
});

test('a JWKS endpoint failure is rejected with 401, never 500', async () => {
  const fx = await startFixture({ jwksFails: true });
  try {
    const token = await fx.sign({ email: 'admin@example.test' });
    const result = await fx.raw('/v1/contacts', 'GET', undefined, {
      'Cf-Access-Jwt-Assertion': token,
    });
    expectUnauthorized(result, 'JWKS failure');
  } finally {
    await fx.dispose();
  }
});

test('a valid Access token is accepted', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.sign({ email: 'admin@example.test' });
    const result = await fx.raw('/v1/contacts', 'GET', undefined, {
      'Cf-Access-Jwt-Assertion': token,
    });
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(Array.isArray(result.json.data)).toBe(true);
    // The bootstrap pipeline exists straight from the migration.
    const pipelines = await fx.raw('/v1/pipelines', 'GET', undefined, {
      'Cf-Access-Jwt-Assertion': token,
    });
    expect(pipelines.status, JSON.stringify(pipelines)).toBe(200);
    const names = (pipelines.json.data as Array<{ name: string }>).map(
      (item) => item.name,
    );
    expect(names).toContain('Sales');
  } finally {
    await fx.dispose();
  }
});

test('a revoked intake token cannot submit and an unknown token is rejected', async () => {
  const fx = await startFixture({ devAdmin: 'intake-auth@example.test' });
  try {
    const created = await fx.raw('/v1/tokens', 'POST', { name: 'to-revoke' });
    expect(created.status, JSON.stringify(created)).toBe(201);
    const { id, token } = created.json.data as { id: string; token: string };
    const payload = {
      contact: { email: 'token-neg@example.test' },
      opportunity: { name: 'Inquiry', source: 'form' },
      source: 'website_form',
    };
    const intake = (auth: string, key: string) =>
      fx.raw('/v1/intakes', 'POST', payload, {
        Authorization: `Bearer ${auth}`,
        'Idempotency-Key': key,
      });

    expect((await intake(token, 'neg-first')).status).toBe(201);
    const revoked = await fx.raw(`/v1/tokens/${id}`, 'DELETE');
    expect(revoked.status, JSON.stringify(revoked)).toBe(204);
    expectUnauthorized(
      await intake(token, 'neg-second'),
      'revoked intake token',
    );
    expectUnauthorized(
      await intake('cld_unknown', 'neg-third'),
      'unknown intake token',
    );
  } finally {
    await fx.dispose();
  }
});
