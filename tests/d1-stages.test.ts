import {
  DEFAULT_PIPELINE_ID,
  DEFAULT_STAGE_ID,
  DEFAULT_WORKSPACE_ID,
} from '@/db/repository';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * D1-backed regression tests for pipelines and their JSON stages:
 *
 * - bootstrap rows (workspace/pipeline/stage) come from the migrations, with
 *   the seeded stage embedded in the default pipeline's `stages` array, and
 *   requests never resurrect deleted rows;
 * - adding a stage appends to the pipeline's ordered JSON array;
 * - concurrent stage creation cannot lose a writer (single-statement append);
 * - the wire contract exposes `{ color, id, name }` per stage.
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
      `Stage D1 tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
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

type Pipeline = {
  archivedAt: null | string;
  id: string;
  name: string;
  stages: Stage[];
};
type Stage = { color: string; id: string; name: string };

type StageFixture = {
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
 * Fresh fixture applying drizzle/ migrations in order.
 */
const startFixture = async (): Promise<StageFixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        DEV_ADMIN_EMAIL: 'stage-regression@example.test',
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
        `https://stage-test.example${path}`,
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

const pipelines = async (fx: StageFixture): Promise<Pipeline[]> =>
  fx.ok<Pipeline[]>('/v1/pipelines', 'GET');

test('bootstrap rows come from the migrations and requests never resurrect them', async () => {
  const fx = await startFixture();
  try {
    // Before any request: the fixed-id bootstrap rows already exist, and the
    // seeded stage lives inside the default pipeline's JSON array.
    const workspace = await fx.db
      .prepare('SELECT slug, name FROM workspaces WHERE id = ?')
      .bind(DEFAULT_WORKSPACE_ID)
      .first();
    expect(workspace).toEqual({ name: 'Lead Desk', slug: 'default' });
    const pipeline = await fx.db
      .prepare('SELECT name, stages, workspace_id FROM pipelines WHERE id = ?')
      .bind(DEFAULT_PIPELINE_ID)
      .first();
    expect(pipeline).toMatchObject({
      name: 'Sales',
      workspace_id: DEFAULT_WORKSPACE_ID,
    });
    expect(JSON.parse((pipeline?.stages as string) ?? '[]') as Stage[]).toEqual(
      [{ color: 'blue', id: DEFAULT_STAGE_ID, name: 'New inquiry' }],
    );

    // The stages table is gone after migration 0011.
    const stagesTable = await fx.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='stages'",
      )
      .first();
    expect(stagesTable).toBeNull();

    // Deleting the bootstrap rows must NOT be undone by any request.
    await fx.db.prepare('DELETE FROM pipelines').run();
    await fx.db.prepare('DELETE FROM workspaces').run();
    const result = await fx.api('/v1/pipelines');
    expect(result.status, JSON.stringify(result)).toBe(200);
    const names = (result.json.data as Array<{ name: string }>).map(
      (item) => item.name,
    );
    expect(names).not.toContain('Sales');
    expect(
      (await fx.db.prepare('SELECT count(*) AS n FROM workspaces').first())?.n,
    ).toBe(0);
  } finally {
    await fx.dispose();
  }
});

test('adding stages appends to the pipeline JSON in order', async () => {
  const fx = await startFixture();
  try {
    const created = await fx.ok<Pipeline>('/v1/pipelines', 'POST', {
      name: 'JSON stages',
    });
    expect(created.stages).toHaveLength(1);
    expect(created.stages[0]?.name).toBe('New inquiry');

    const first = await fx.ok<Stage>(
      `/v1/pipelines/${created.id}/stages`,
      'POST',
      { color: 'amber', name: 'Contacted' },
    );
    expect(first).toEqual({
      color: 'amber',
      id: expect.any(String) as unknown as string,
      name: 'Contacted',
    });
    await fx.ok<Stage>(`/v1/pipelines/${created.id}/stages`, 'POST', {
      name: 'Qualified',
    });

    const loaded = (await pipelines(fx)).find(
      (pipeline) => pipeline.id === created.id,
    );
    expect(loaded?.stages.map((stage) => stage.name)).toEqual([
      'New inquiry',
      'Contacted',
      'Qualified',
    ]);
    // The default color applies when omitted; no extra stage fields leak.
    expect(loaded?.stages[2]).toEqual({
      color: 'slate',
      id: expect.any(String) as unknown as string,
      name: 'Qualified',
    });
  } finally {
    await fx.dispose();
  }
});

test('concurrent stage creation keeps every stage', async () => {
  const fx = await startFixture();
  try {
    const pipeline = await fx.ok<Pipeline>('/v1/pipelines', 'POST', {
      name: 'Race',
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        fx.api(`/v1/pipelines/${pipeline.id}/stages`, 'POST', {
          name: `S${index}`,
        }),
      ),
    );
    for (const result of results) {
      expect(result.status, JSON.stringify(result)).toBe(201);
    }

    const loaded = (await pipelines(fx)).find(
      (item) => item.id === pipeline.id,
    );
    expect(loaded?.stages).toHaveLength(7);
    expect(new Set(loaded?.stages.map((stage) => stage.id)).size).toBe(7);
    expect(new Set(loaded?.stages.map((stage) => stage.name)).size).toBe(7);
  } finally {
    await fx.dispose();
  }
});

test('adding a stage to an unknown pipeline returns 404', async () => {
  const fx = await startFixture();
  try {
    const result = await fx.api(
      '/v1/pipelines/01ARZ3NDEKTSV4RRFFQ69G5FAZ/stages',
      'POST',
      { name: 'Nowhere' },
    );
    expect(result.status, JSON.stringify(result)).toBe(404);
    expect(result.json.code).toBe('not_found');
  } finally {
    await fx.dispose();
  }
});

test('Standard Schema routes keep the shared validation envelope', async () => {
  const fx = await startFixture();
  try {
    // POST /v1/pipelines validates through Elysia's Standard Schema path.
    const invalid = await fx.api('/v1/pipelines', 'POST', { name: '' });
    expect(invalid.status, JSON.stringify(invalid)).toBe(422);
    expect(invalid.json).toMatchObject({
      code: 'validation_error',
      message: 'The request is invalid.',
    });

    // GET /health declares a response schema; the plain handler value passes.
    const healthy = await fx.api('/health');
    expect(healthy.status).toBe(200);
    expect(healthy.json).toEqual({ ok: true });
  } finally {
    await fx.dispose();
  }
});

test('rename, archive, name reuse, and unarchive conflicts', async () => {
  const fx = await startFixture();
  try {
    const alpha = await fx.ok<Pipeline>('/v1/pipelines', 'POST', {
      name: 'Alpha',
    });
    const renamed = await fx.ok<Pipeline>(
      `/v1/pipelines/${alpha.id}`,
      'PATCH',
      {
        name: 'Beta',
      },
    );
    expect(renamed.name).toBe('Beta');

    const gamma = await fx.ok<Pipeline>('/v1/pipelines', 'POST', {
      name: 'Gamma',
    });
    const duplicate = await fx.api(`/v1/pipelines/${gamma.id}`, 'PATCH', {
      name: 'Beta',
    });
    expect(duplicate.status, JSON.stringify(duplicate)).toBe(422);
    expect(duplicate.json.code).toBe('pipeline_name_taken');

    const archived = await fx.ok<Pipeline>(
      `/v1/pipelines/${alpha.id}`,
      'PATCH',
      { archived: true },
    );
    expect(archived.archivedAt).not.toBeNull();

    const reused = await fx.ok<Pipeline>('/v1/pipelines', 'POST', {
      name: 'Beta',
    });
    expect(reused.name).toBe('Beta');

    const unarchiveConflict = await fx.api(
      `/v1/pipelines/${alpha.id}`,
      'PATCH',
      { archived: false },
    );
    expect(unarchiveConflict.status, JSON.stringify(unarchiveConflict)).toBe(
      422,
    );
    expect(unarchiveConflict.json.code).toBe('pipeline_name_taken');

    await fx.ok<Pipeline>(`/v1/pipelines/${reused.id}`, 'PATCH', {
      archived: true,
    });
    const unarchived = await fx.ok<Pipeline>(
      `/v1/pipelines/${alpha.id}`,
      'PATCH',
      { archived: false },
    );
    expect(unarchived.archivedAt).toBeNull();
  } finally {
    await fx.dispose();
  }
});

test('stage rename, recolor, reorder, and delete rules', async () => {
  const fx = await startFixture();
  try {
    const pipeline = await fx.ok<Pipeline>('/v1/pipelines', 'POST', {
      name: 'Stages',
    });
    const seeded = pipeline.stages[0];
    if (seeded === undefined) {
      throw new Error('expected a seeded stage');
    }

    const added = await fx.ok<Stage>(
      `/v1/pipelines/${pipeline.id}/stages`,
      'POST',
      { color: 'amber', name: 'Contacted' },
    );

    const updated = await fx.ok<Pipeline>(
      `/v1/pipelines/${pipeline.id}/stages/${seeded.id}`,
      'PATCH',
      { color: 'emerald', name: 'Inbox' },
    );
    expect(updated.stages[0]).toEqual({
      color: 'emerald',
      id: seeded.id,
      name: 'Inbox',
    });

    const reordered = await fx.ok<Pipeline>(
      `/v1/pipelines/${pipeline.id}/stages/reorder`,
      'POST',
      { stageIds: [added.id, seeded.id] },
    );
    expect(reordered.stages.map((stage) => stage.id)).toEqual([
      added.id,
      seeded.id,
    ]);

    const invalid = await fx.api(
      `/v1/pipelines/${pipeline.id}/stages/reorder`,
      'POST',
      { stageIds: [added.id] },
    );
    expect(invalid.status, JSON.stringify(invalid)).toBe(422);
    expect(invalid.json.code).toBe('invalid_stages');

    const lastStage = await fx.api(
      `/v1/pipelines/${DEFAULT_PIPELINE_ID}/stages/${DEFAULT_STAGE_ID}`,
      'DELETE',
    );
    expect(lastStage.status, JSON.stringify(lastStage)).toBe(422);
    expect(lastStage.json.code).toBe('last_stage');

    const deleted = await fx.ok<Pipeline>(
      `/v1/pipelines/${pipeline.id}/stages/${added.id}`,
      'DELETE',
    );
    expect(deleted.stages.map((stage) => stage.id)).toEqual([seeded.id]);

    const unknownStage = await fx.api(
      `/v1/pipelines/${pipeline.id}/stages/01ARZ3NDEKTSV4RRFFQ69G5FAZ`,
      'DELETE',
    );
    expect(unknownStage.status).toBe(404);
  } finally {
    await fx.dispose();
  }
});

test('a stage with live leads cannot be deleted', async () => {
  const fx = await startFixture();
  try {
    const pipeline = await fx.ok<Pipeline>('/v1/pipelines', 'POST', {
      name: 'In use',
    });
    const stage = pipeline.stages[0];
    if (stage === undefined) {
      throw new Error('expected a seeded stage');
    }

    await fx.ok(`/v1/pipelines/${pipeline.id}/stages`, 'POST', {
      name: 'Second',
    });
    const timestamp = Date.now();
    await fx.db
      .prepare(
        `INSERT INTO leads (
          id, workspace_id, pipeline_id, stage_id, email, normalized_email,
          first_name, last_name, name, source, estimated_value, custom_fields,
          origin, public_key_id, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'Blocked', 'website',
          NULL, '{}', NULL, NULL, ?, ?, NULL)`,
      )
      .bind(
        'lead-in-use',
        DEFAULT_WORKSPACE_ID,
        pipeline.id,
        stage.id,
        timestamp,
        timestamp,
      )
      .run();

    const result = await fx.api(
      `/v1/pipelines/${pipeline.id}/stages/${stage.id}`,
      'DELETE',
    );
    expect(result.status, JSON.stringify(result)).toBe(422);
    expect(result.json).toMatchObject({
      code: 'stage_in_use',
      details: { count: 1 },
    });
  } finally {
    await fx.dispose();
  }
});
