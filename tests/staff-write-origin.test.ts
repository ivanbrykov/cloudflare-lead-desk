import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Staff API writes are cookie-authenticated. This fixture exercises the
 * hostile same-site form shape at the HTTP layer: a cross-origin Origin must
 * be rejected, and a form content type must never reach a JSON route handler.
 */

const repoRoot = process.cwd();
const APP_ORIGIN = 'https://staff-test.example';

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

type WriteFixture = {
  dispose: () => Promise<void>;
  request: (
    path: string,
    init?: {
      body?: string;
      contentType?: null | string;
      method?: string;
      origin?: null | string;
    },
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
};

const startFixture = async (): Promise<WriteFixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        DEV_ADMIN_EMAIL: 'origin-regression@example.test',
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

    const request = async (
      path: string,
      init: {
        body?: string;
        contentType?: null | string;
        method?: string;
        origin?: null | string;
      } = {},
    ): Promise<{ json: Record<string, unknown>; status: number }> => {
      const headers: Record<string, string> = {};
      const origin = init.origin === undefined ? APP_ORIGIN : init.origin;
      if (origin !== null) {
        headers['Origin'] = origin;
      }

      const contentType =
        init.contentType === undefined ? 'application/json' : init.contentType;
      if (contentType !== null && init.body !== undefined) {
        headers['Content-Type'] = contentType;
      }

      const response = await mf.dispatchFetch(`${APP_ORIGIN}${path}`, {
        ...(init.body === undefined ? {} : { body: init.body }),
        headers,
        method: init.method ?? 'GET',
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }

      return { json, status: response.status };
    };

    return { dispose, request };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const jsonBody = JSON.stringify({
  email: 'csrf@example.test',
  firstName: 'Csrf',
  source: 'Test',
});
const formBody = 'email=csrf%40example.test&firstName=Csrf&source=form';

test('rejects a cross-origin JSON write without mutating state', async () => {
  const fx = await startFixture();
  try {
    const rejected = await fx.request('/v1/leads', {
      body: jsonBody,
      method: 'POST',
      origin: 'https://evil.example',
    });
    expect(rejected.status).toBe(403);
    expect(rejected.json).toMatchObject({ code: 'forbidden' });

    const list = await fx.request('/v1/leads', { origin: null });
    expect(list.status).toBe(200);
    expect(list.json.data).toEqual([]);
  } finally {
    await fx.dispose();
  }
});

test('rejects a same-site sibling origin', async () => {
  const fx = await startFixture();
  try {
    const rejected = await fx.request('/v1/leads', {
      body: jsonBody,
      method: 'POST',
      origin: 'https://evil.staff-test.example',
    });
    expect(rejected.status).toBe(403);
    expect(rejected.json).toMatchObject({ code: 'forbidden' });
  } finally {
    await fx.dispose();
  }
});

test('rejects hostile form posts even with a trusted origin', async () => {
  const fx = await startFixture();
  try {
    const crossOriginForm = await fx.request('/v1/leads', {
      body: formBody,
      contentType: 'application/x-www-form-urlencoded',
      method: 'POST',
      origin: 'https://evil.example',
    });
    expect(crossOriginForm.status).toBe(403);

    const sameOriginForm = await fx.request('/v1/leads', {
      body: formBody,
      contentType: 'application/x-www-form-urlencoded',
      method: 'POST',
    });
    expect(sameOriginForm.status).toBe(415);
    expect(sameOriginForm.json).toMatchObject({
      code: 'unsupported_media_type',
    });

    const list = await fx.request('/v1/leads', { origin: null });
    expect(list.json.data).toEqual([]);
  } finally {
    await fx.dispose();
  }
});

test('accepts trusted-origin and non-browser JSON writes', async () => {
  const fx = await startFixture();
  try {
    const sameOrigin = await fx.request('/v1/leads', {
      body: jsonBody,
      method: 'POST',
    });
    expect(sameOrigin.status, JSON.stringify(sameOrigin)).toBe(201);

    const nonBrowser = await fx.request('/v1/leads', {
      body: JSON.stringify({ email: 'cli@example.test', source: 'CLI' }),
      method: 'POST',
      origin: null,
    });
    expect(nonBrowser.status).toBe(201);

    const list = await fx.request('/v1/leads', { origin: null });
    expect(list.json.data).toHaveLength(2);
  } finally {
    await fx.dispose();
  }
});
