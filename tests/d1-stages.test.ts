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
 * D1-backed regression tests for migration bootstrapping and deterministic
 * stage positions:
 *
 * - bootstrap rows (workspace/pipeline/stage) come from migration 0002, not
 *   from per-request seeding, and requests never resurrect deleted rows;
 * - migration 0002 renumbers duplicate (pipeline_id, position) rows in a
 *   deterministic (created_at, id) order before the unique index is added;
 * - concurrent stage creation yields unique contiguous positions from 0.
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
 * Fresh fixture applying drizzle/ migrations in order. `preLastMigration`
 * runs after every migration except the last, mirroring a database that
 * accumulated data (e.g. duplicate stage positions) before 0002 shipped.
 */
const startFixture = async (
  options: { preLastMigration?: (database: D1Database) => Promise<void> } = {},
): Promise<StageFixture> => {
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
    for (let index = 0; index < names.length; index += 1) {
      if (options.preLastMigration && index === names.length - 1) {
        await options.preLastMigration(database);
      }

      const sql = await readFile(
        join(repoRoot, 'drizzle', names[index]),
        'utf8',
      );
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

test('bootstrap rows come from the migration and requests never resurrect them', async () => {
  const fx = await startFixture();
  try {
    // Before any request: the fixed-id bootstrap rows already exist.
    const workspace = await fx.db
      .prepare('SELECT slug, name FROM workspaces WHERE id = ?')
      .bind(DEFAULT_WORKSPACE_ID)
      .first();
    expect(workspace).toEqual({ name: 'Lead Desk', slug: 'default' });
    const pipeline = await fx.db
      .prepare('SELECT name, workspace_id FROM pipelines WHERE id = ?')
      .bind(DEFAULT_PIPELINE_ID)
      .first();
    expect(pipeline).toEqual({
      name: 'Sales',
      workspace_id: DEFAULT_WORKSPACE_ID,
    });
    const stage = await fx.db
      .prepare('SELECT name, position, pipeline_id FROM stages WHERE id = ?')
      .bind(DEFAULT_STAGE_ID)
      .first();
    expect(stage).toEqual({
      name: 'New inquiry',
      pipeline_id: DEFAULT_PIPELINE_ID,
      position: 0,
    });

    // Deleting the bootstrap rows must NOT be undone by any request.
    await fx.db.prepare('DELETE FROM stages').run();
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

test('the migration renumbers duplicate positions deterministically before enforcing uniqueness', async () => {
  const fx = await startFixture({
    preLastMigration: async (database) => {
      // A pre-0002 database: same workspace id, a second pipeline whose
      // stages all share position 0 (legal before the unique index).
      await database
        .prepare(
          'INSERT OR IGNORE INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          DEFAULT_WORKSPACE_ID,
          'default',
          'Lead Desk',
          '2026-01-01',
          '2026-01-01',
        )
        .run();
      await database
        .prepare(
          'INSERT OR IGNORE INTO pipelines (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          '01ARZ3NDEKTSV4RRFFQ69G5FD0',
          DEFAULT_WORKSPACE_ID,
          'Legacy',
          '2026-01-01',
          '2026-01-01',
        )
        .run();
      for (let index = 0; index < 3; index += 1) {
        await database
          .prepare(
            'INSERT INTO stages (id, workspace_id, pipeline_id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            `01ARZ3NDEKTSV4RRFFQ69G5FE${index}`,
            DEFAULT_WORKSPACE_ID,
            '01ARZ3NDEKTSV4RRFFQ69G5FD0',
            `Dup${index}`,
            'blue',
            0,
            `2026-01-0${1 + index}`,
            `2026-01-0${1 + index}`,
          )
          .run();
      }
    },
  });
  try {
    const rows = (
      await fx.db
        .prepare(
          'SELECT pipeline_id AS p, position FROM stages ORDER BY pipeline_id, position',
        )
        .all()
    ).results;
    // Within each pipeline, positions are unique and contiguous from 0,
    // following the stable (created_at, id) order.
    const byPipeline = new Map<string, number[]>();
    for (const row of rows) {
      const list = byPipeline.get(row.p as string) ?? [];
      list.push(row.position as number);
      byPipeline.set(row.p as string, list);
    }

    for (const [pipelineId, positions] of byPipeline) {
      expect(positions, pipelineId).toEqual(positions.map((_, index) => index));
    }

    // The API keeps serving the renumbered stages.
    const pipelines = await fx.api('/v1/pipelines');
    expect(pipelines.status, JSON.stringify(pipelines)).toBe(200);
  } finally {
    await fx.dispose();
  }
});

test('concurrent stage creation yields unique contiguous positions from zero', async () => {
  const fx = await startFixture();
  try {
    const pipeline = await fx.ok<{ id: string }>('/v1/pipelines', 'POST', {
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

    const rows = await fx.db
      .prepare(
        'SELECT position FROM stages WHERE pipeline_id = ? ORDER BY position',
      )
      .bind(pipeline.id)
      .all();
    expect(rows.results.map((row) => row.position)).toEqual([0, 1, 2, 3, 4, 5]);
  } finally {
    await fx.dispose();
  }
});

test('an explicit colliding position is rejected instead of creating a duplicate', async () => {
  const fx = await startFixture();
  try {
    // The bootstrap stage already holds position 0 in the default pipeline.
    const result = await fx.api(
      `/v1/pipelines/${DEFAULT_PIPELINE_ID}/stages`,
      'POST',
      { name: 'Explicit', position: 0 },
    );
    expect(result.status, JSON.stringify(result)).toBe(500);
    expect(result.json.code).toBe('persistence_error');
    const rows = await fx.db
      .prepare(
        'SELECT position FROM stages WHERE pipeline_id = ? ORDER BY position',
      )
      .bind(DEFAULT_PIPELINE_ID)
      .all();
    expect(rows.results.map((row) => row.position)).toEqual([0]);
  } finally {
    await fx.dispose();
  }
});
