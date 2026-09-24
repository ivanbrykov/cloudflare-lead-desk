import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * D1-backed regression tests for DELETE /v1/opportunities/:id (soft delete):
 *
 * - soft deletion removes the opportunity from `GET /v1/opportunities` (with
 *   and without the pipelineId filter) while the row, its custom-field
 *   values, and its activity history stay in D1;
 * - the deleted record stays fetchable by id and reports `deletedAt`;
 * - soft deletion is one-way: a second DELETE, an unknown id, and a malformed
 *   id return 404 not_found without touching any row;
 * - the deletion timestamp is persisted and `updatedAt` moves forward;
 * - unauthenticated requests return 401 unauthorized and write nothing.
 *
 * Every test builds its own Miniflare + in-memory D1 fixture (migrations
 * applied from drizzle/), so tests are independently runnable.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Soft-delete D1 tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

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

type Opportunity = {
  contact: {
    email: null | string;
    firstName: null | string;
    id: string;
    lastName: null | string;
  };
  createdAt: string;
  customFields: Record<string, unknown>;
  deletedAt: null | string;
  estimatedValue: null | number;
  id: string;
  name: string;
  pipelineId: string;
  stageId: string;
  updatedAt: string;
};

type SoftDeleteFixture = {
  api: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  db: D1Database;
  dispose: () => Promise<void>;
  ok: <T>(path: string, method: string, body?: unknown) => Promise<T>;
};

/**
 * Fresh in-memory D1 fixture with drizzle/ migrations applied. Without
 * `devAdmin: false` the fixture sets DEV_ADMIN_EMAIL (ENVIRONMENT=test), so
 * every request is authenticated; with it the fixture has no identity at all,
 * which exercises the 401 path without needing the JWKS endpoint.
 */
const startFixture = async (
  options: { devAdmin?: boolean } = {},
): Promise<SoftDeleteFixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        ...(options.devAdmin === false
          ? {}
          : { DEV_ADMIN_EMAIL: 'soft-delete-regression@example.test' }),
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

    const api = async (
      path: string,
      method = 'GET',
      body?: unknown,
    ): Promise<{ json: Record<string, unknown>; status: number }> => {
      const response = await mf.dispatchFetch(
        `https://soft-delete-test.example${path}`,
        {
          headers: { 'Content-Type': 'application/json' },
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

    const ok = async <T>(
      path: string,
      method: string,
      body?: unknown,
    ): Promise<T> => {
      const result = await api(path, method, body);
      expect(
        result.status >= 200 && result.status < 300,
        `${method} ${path} -> ${result.status}: ${JSON.stringify(result)}`,
      ).toBe(true);
      return result.json.data as T;
    };

    return { api, db: database, dispose, ok };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });

const createOpportunity = async (
  fx: SoftDeleteFixture,
  name: string,
): Promise<Opportunity> => {
  const contact = await fx.ok<{ id: string }>('/v1/contacts', 'POST', {
    email: `${name.toLowerCase().replaceAll(/\W+/gu, '-')}@example.test`,
    firstName: name,
  });
  return fx.ok<Opportunity>('/v1/opportunities', 'POST', {
    contactId: contact.id,
    name,
  });
};

const opportunityRow = (fx: SoftDeleteFixture, id: string) =>
  fx.db
    .prepare(
      'SELECT deleted_at, name, updated_at FROM opportunities WHERE id = ?',
    )
    .bind(id)
    .first();

test('DELETE soft-deletes an opportunity, hides it from listings, and keeps the record', async () => {
  const fx = await startFixture();
  try {
    const deleted = await createOpportunity(fx, 'Deleted deal');
    const kept = await createOpportunity(fx, 'Kept deal');
    await fx.ok(`/v1/opportunities/${deleted.id}/activities`, 'POST', {
      body: 'Called the customer',
      kind: 'note',
    });
    const before = (await opportunityRow(fx, deleted.id)) as Record<
      string,
      null | string
    >;

    await tick();
    const result = await fx.api(`/v1/opportunities/${deleted.id}`, 'DELETE');
    expect(result.status, JSON.stringify(result)).toBe(204);

    const row = (await opportunityRow(fx, deleted.id)) as Record<
      string,
      null | string
    >;
    expect(typeof row.deleted_at).toBe('string');
    expect(row.name).toBe('Deleted deal');
    expect(row.updated_at, 'updated_at must move forward on delete').not.toBe(
      before.updated_at,
    );

    const list = await fx.ok<Opportunity[]>('/v1/opportunities', 'GET');
    expect(list.map((item) => item.id)).toEqual([kept.id]);

    const filtered = await fx.ok<Opportunity[]>(
      `/v1/opportunities?pipelineId=${deleted.pipelineId}`,
      'GET',
    );
    expect(filtered.map((item) => item.id)).toEqual([kept.id]);

    const read = await fx.ok<Opportunity>(
      `/v1/opportunities/${deleted.id}`,
      'GET',
    );
    expect(read.deletedAt).toBe(row.deleted_at);
    expect(read.name).toBe('Deleted deal');
    expect(read.stageId).toBe(deleted.stageId);
    expect(read.contact.id).toBe(deleted.contact.id);

    const activities = await fx.ok<Array<{ body: string }>>(
      `/v1/opportunities/${deleted.id}/activities`,
      'GET',
    );
    expect(
      activities.some((activity) => activity.body === 'Called the customer'),
    ).toBe(true);
  } finally {
    await fx.dispose();
  }
});

test('DELETE is one-way: soft-deleted, unknown, and malformed ids return 404 without changes', async () => {
  const fx = await startFixture();
  try {
    const opportunity = await createOpportunity(fx, 'Once only');
    await tick();
    const first = await fx.api(`/v1/opportunities/${opportunity.id}`, 'DELETE');
    expect(first.status, JSON.stringify(first)).toBe(204);
    const deletedAt = (await opportunityRow(fx, opportunity.id))
      ?.deleted_at as string;

    await tick();
    const second = await fx.api(
      `/v1/opportunities/${opportunity.id}`,
      'DELETE',
    );
    expect(second.status, JSON.stringify(second)).toBe(404);
    expect(second.json.code, JSON.stringify(second)).toBe('not_found');

    const unknown = await fx.api(
      '/v1/opportunities/01ARZ3NDEKTSV4RRFFQ69G5FC9',
      'DELETE',
    );
    expect(unknown.status, JSON.stringify(unknown)).toBe(404);
    expect(unknown.json.code, JSON.stringify(unknown)).toBe('not_found');

    const malformed = await fx.api('/v1/opportunities/not-a-ulid', 'DELETE');
    expect(malformed.status, JSON.stringify(malformed)).toBe(404);
    expect(malformed.json.code, JSON.stringify(malformed)).toBe('not_found');

    const row = (await opportunityRow(fx, opportunity.id)) as Record<
      string,
      null | string
    >;
    expect(row.deleted_at).toBe(deletedAt);
  } finally {
    await fx.dispose();
  }
});

test('DELETE requires an authenticated identity (401 unauthorized)', async () => {
  const fx = await startFixture({ devAdmin: false });
  try {
    const result = await fx.api(
      '/v1/opportunities/01ARZ3NDEKTSV4RRFFQ69G5FC9',
      'DELETE',
    );
    expect(result.status, JSON.stringify(result)).toBe(401);
    expect(result.json.code, JSON.stringify(result)).toBe('unauthorized');
    expect(typeof result.json.message).toBe('string');

    const count = await fx.db
      .prepare('SELECT count(*) AS n FROM opportunities')
      .first();
    expect(count?.n).toBe(0);
  } finally {
    await fx.dispose();
  }
});
