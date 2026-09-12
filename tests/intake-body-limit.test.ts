import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Stage 2 review regressions for the library-backed intake body limit.
 *
 * Finding 1: every accepted alias of `POST /v1/intakes` (`/v1/intakes`,
 * `/v1/intakes/`, and the normalized `/v1/intakes/.`) must enforce the same
 * 65,536 ACTUAL-byte limit before JSON decoding and domain writes.
 *
 * Finding 2: an oversized body must return the existing
 * `413 payload_too_large` response, persist nothing, and cancel a still-open
 * input stream, releasing the reader lock through the library's own
 * iteration cleanup.
 *
 * The fixture bundles `tests/intake-cancellation-probe.ts`, a thin wrapper
 * around the real exported worker (`src/worker-global.ts`). Every request
 * passes through the wrapper to the actual worker; only the dedicated
 * `/__intake_cancellation` probe builds its oversized stream inside the
 * worker, because Miniflare does not propagate cancellation of a
 * Node-created body stream back to the Node side.
 *
 * Every test starts its own Miniflare + in-memory D1 fixture (migrations
 * applied from drizzle/), so tests are independently runnable and never
 * rely on setup performed by a preceding test.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Intake body-limit tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

const TABLES = [
  'contacts',
  'opportunities',
  'activities',
  'custom_field_values',
  'idempotency_keys',
];

const INTAKE_ALIASES = ['/v1/intakes', '/v1/intakes/', '/v1/intakes/.'];

type Fixture = {
  api: (
    path: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  count: (table: string) => Promise<number>;
  createToken: (name?: string) => Promise<{ id: string; token: string }>;
  db: D1Database;
  dispose: () => Promise<void>;
  intake: (
    key: string | undefined,
    input?: IntakePayload | string,
    authToken?: string,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  ok: <T>(
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<T>;
  raw: (
    path: string,
    method: string,
    body?: ReadableStream<Uint8Array<ArrayBuffer>> | string,
    headers?: Record<string, string | undefined>,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  snapshot: () => Promise<Record<string, unknown[]>>;
};

type IntakePayload = {
  contact: {
    email: string;
    firstName?: string;
  };
  opportunity: {
    name: string;
    source: string;
  };
  source: string;
};

const payload = (email = 'body-limit@example.test'): IntakePayload => ({
  contact: { email, firstName: 'Sam' },
  opportunity: { name: 'New inquiry', source: 'form' },
  source: 'website_form',
});

const workerScripts = new Map<string, string>();

const bundleWorker = async (
  entry = 'tests/intake-cancellation-probe.ts',
): Promise<string> => {
  const cached = workerScripts.get(entry);
  if (cached) {
    return cached;
  }

  await assertRepoRoot();
  const bundled = await build({
    bundle: true,
    entryPoints: [join(repoRoot, entry)],
    external: ['cloudflare:*', 'node:*'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: join(repoRoot, 'tsconfig.json'),
    write: false,
  });
  const script = bundled.outputFiles[0].text;
  workerScripts.set(entry, script);
  return script;
};

const startFixture = async (entry?: string): Promise<Fixture> => {
  const script = await bundleWorker(entry);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        DEV_ADMIN_EMAIL: 'body-limit@example.test',
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

    const raw = async (
      path: string,
      method = 'GET',
      body?: ReadableStream<Uint8Array<ArrayBuffer>> | string,
      headers: Record<string, string | undefined> = {},
    ): Promise<{ json: Record<string, unknown>; status: number }> => {
      // The stream body and its duplex mode are not modelled by the
      // RequestInit type here; both are supported by the runtime.
      const requestHeaders = new Headers({
        'Content-Type': 'application/json',
      });
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) {
          requestHeaders.delete(name);
        } else {
          requestHeaders.set(name, value);
        }
      }

      const init: Record<string, unknown> = { headers: requestHeaders, method };
      if (body !== undefined) {
        if (body instanceof ReadableStream) {
          init.duplex = 'half';
        }

        init.body = body;
      }

      const response = await mf.dispatchFetch(
        `https://body-limit.example${path}`,
        init as unknown as Parameters<Miniflare['dispatchFetch']>[1],
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

    const api = (
      path: string,
      method = 'GET',
      body?: unknown,
      headers?: Record<string, string>,
    ) =>
      raw(
        path,
        method,
        body === undefined ? undefined : JSON.stringify(body),
        headers,
      );
    const ok = async <T>(
      path: string,
      method = 'GET',
      body?: unknown,
      headers?: Record<string, string>,
    ): Promise<T> => {
      const result = await api(path, method, body, headers);
      expect(
        result.status >= 200 && result.status < 300,
        `${method} ${path} -> ${result.status}: ${JSON.stringify(result)}`,
      ).toBe(true);
      return result.json.data as T;
    };

    let lastToken: { id: string; token: string };
    const createToken = async (name = 'body-limit-token') => {
      lastToken = await ok<{ id: string; token: string }>(
        '/v1/tokens',
        'POST',
        {
          name,
        },
      );
      return lastToken;
    };

    const intake = (
      key: string | undefined,
      input: IntakePayload | string = payload(),
      authToken?: string,
    ) => {
      const token = authToken ?? lastToken.token;
      const body = typeof input === 'string' ? input : JSON.stringify(input);
      return raw('/v1/intakes', 'POST', body, {
        Authorization: `Bearer ${token}`,
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      });
    };

    return {
      api,
      count: async (table: string) =>
        ((await database.prepare(`SELECT count(*) AS n FROM ${table}`).first())
          ?.n ?? 0) as number,
      createToken,
      db: database,
      dispose,
      intake,
      ok,
      raw,
      snapshot: async () =>
        Object.fromEntries(
          await Promise.all(
            TABLES.map(
              async (table) =>
                [
                  table,
                  (await database.prepare(`SELECT * FROM ${table}`).all())
                    .results,
                ] as [string, unknown[]],
            ),
          ),
        ),
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const expectError = (
  result: { json: Record<string, unknown>; status: number },
  status: number,
  code: string,
) => {
  expect(result.status, JSON.stringify(result)).toBe(status);
  expect(result.json.code).toBe(code);
};

const stream = (text: string): ReadableStream<Uint8Array<ArrayBuffer>> =>
  new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      for (let offset = 0; offset < bytes.length; offset += 777) {
        controller.enqueue(bytes.slice(offset, offset + 777));
      }

      controller.close();
    },
  });

test('every intake route alias enforces the same 65,536-byte limit without writes', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const before = await fx.snapshot();
    const oversized = JSON.stringify({
      ...payload(),
      source: 'x'.repeat(70_000),
    });
    const headers = {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'alias-oversized',
    };

    // Streamed body without a declared Content-Length.
    for (const path of INTAKE_ALIASES) {
      expectError(
        await fx.raw(path, 'POST', stream(oversized), headers),
        413,
        'payload_too_large',
      );
    }

    // Declared Content-Length over the limit, including multibyte UTF-8.
    const multibyte = JSON.stringify({
      ...payload(),
      source: '\u{1F600}'.repeat(17_000),
    });
    for (const path of INTAKE_ALIASES) {
      expectError(
        await fx.raw(path, 'POST', multibyte, {
          ...headers,
          'Content-Length': String(new TextEncoder().encode(multibyte).length),
        }),
        413,
        'payload_too_large',
      );
    }

    expect(await fx.snapshot()).toEqual(before);
  } finally {
    await fx.dispose();
  }
});

test('the exact 65,536-byte boundary is accepted on every alias', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const input = JSON.stringify(payload());
    const byteLength = new TextEncoder().encode(input).length;
    const exact = input + ' '.repeat(65_536 - byteLength);
    const headers = {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'alias-exact',
    };

    for (const [index, path] of INTAKE_ALIASES.entries()) {
      const result = await fx.raw(path, 'POST', stream(exact), {
        ...headers,
        'Idempotency-Key': `alias-exact-${index}`,
      });
      expect(result.status, JSON.stringify(result)).toBe(201);
    }

    expect(await fx.count('opportunities')).toBe(3);
    expect(await fx.count('idempotency_keys')).toBe(3);
  } finally {
    await fx.dispose();
  }
});

test('valid and malformed alias requests keep their expected behavior', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    for (const [index, path] of INTAKE_ALIASES.entries()) {
      const result = await fx.raw(path, 'POST', JSON.stringify(payload()), {
        Authorization: `Bearer ${token.token}`,
        'Idempotency-Key': `alias-valid-${index}`,
      });
      expect(result.status, JSON.stringify(result)).toBe(201);
    }

    const before = await fx.snapshot();
    const malformed = await fx.raw('/v1/intakes/', 'POST', '{invalid', {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'alias-malformed',
    });
    expect(malformed.status, JSON.stringify(malformed)).toBe(400);
    expect(await fx.snapshot()).toEqual(before);
  } finally {
    await fx.dispose();
  }
});

test('the worker cancels an oversized still-open intake stream and releases it', async () => {
  const fx = await startFixture();
  try {
    await fx.createToken();
    const before = await fx.snapshot();

    // The probe builds the 65,537-byte stream inside the worker with an
    // open (never self-closing) source, sends it to the real worker's
    // /v1/intakes WITHOUT any Authorization header, and reports the
    // stream state. The limit must apply before token checks and must
    // cancel the open stream through the library's iteration cleanup.
    const result = await fx.raw('/__intake_cancellation', 'POST');
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.json.status).toBe(413);
    expect(result.json.cancelled).toBe(true);
    expect(result.json.locked).toBe(false);
    expect(String(result.json.responseBody)).toContain('payload_too_large');
    expect(await fx.snapshot()).toEqual(before);
  } finally {
    await fx.dispose();
  }
});

test('non-JSON and missing content types cannot bypass the byte limit', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const before = await fx.snapshot();
    for (const contentType of [
      undefined,
      '',
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/octet-stream',
    ]) {
      for (const path of INTAKE_ALIASES) {
        const headers = {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': contentType,
          'Idempotency-Key': 'unsupported',
        };
        expectError(
          await fx.raw(path, 'POST', stream('x'.repeat(65_537)), headers),
          413,
          'payload_too_large',
        );
        expectError(
          await fx.raw(path, 'POST', stream('{}'), headers),
          415,
          'unsupported_media_type',
        );
      }
    }

    expect(await fx.snapshot()).toEqual(before);
  } finally {
    await fx.dispose();
  }
});

test('the alternate entry delegates to the same compiled Worker', async () => {
  const fx = await startFixture('src/worker.ts');
  try {
    expect((await fx.raw('/health', 'GET')).status).toBe(200);
    const token = await fx.createToken();
    const before = await fx.snapshot();
    const headers = {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'alternate',
    };
    expectError(
      await fx.raw('/v1/intakes/', 'POST', stream('x'.repeat(65_537)), headers),
      413,
      'payload_too_large',
    );
    expect(await fx.snapshot()).toEqual(before);
    expect(
      (await fx.raw('/v1/intakes/', 'POST', JSON.stringify(payload()), headers))
        .status,
    ).toBe(201);
  } finally {
    await fx.dispose();
  }
});
