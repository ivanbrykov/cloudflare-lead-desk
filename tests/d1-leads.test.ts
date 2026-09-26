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
 * D1-backed tests for the leads read path added in Phase 2:
 *
 * - the list endpoint applies pipeline/stage/search filters, excludes
 *   soft-deleted leads, pages by keyset cursor, and reports duplicate hints;
 * - stage counts and the detail/activities reads work;
 * - Standard Schema query validation answers the shared error envelope.
 *
 * Migration 0008 only creates the `leads` table and links activities; there is
 * no data backfill because there are no production installations yet.
 */

const repoRoot = process.cwd();
const WORKSPACE = DEFAULT_WORKSPACE_ID;
const PIPELINE = DEFAULT_PIPELINE_ID;
const STAGE = DEFAULT_STAGE_ID;
const ms = (offset: number) => Date.now() - offset;

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

type LeadsFixture = {
  api: (
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  db: D1Database;
  dispose: () => Promise<void>;
};

const startFixture = async (
  options: { unauthenticated?: boolean } = {},
): Promise<LeadsFixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ...(options.unauthenticated
          ? {}
          : { DEV_ADMIN_EMAIL: 'leads-regression@example.test' }),
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
        `https://leads-test.example${path}`,
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

    return { api, db: database, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const insertLead = async (
  database: D1Database,
  lead: {
    createdAt: number;
    deletedAt?: null | number;
    email?: null | string;
    id: string;
    name: string;
    source?: string;
    stageId?: string;
  },
): Promise<void> => {
  const email = lead.email ?? null;
  await database
    .prepare(
      `INSERT INTO leads (
        id, workspace_id, pipeline_id, stage_id, email, normalized_email,
        first_name, last_name, name, source, estimated_value, custom_fields,
        origin, public_key_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', NULL, NULL, ?, ?, ?)`,
    )
    .bind(
      lead.id,
      WORKSPACE,
      PIPELINE,
      lead.stageId ?? STAGE,
      email,
      email === null ? null : email.trim().toLowerCase(),
      'Test',
      'Lead',
      lead.name,
      lead.source ?? 'website',
      lead.createdAt,
      lead.createdAt,
      lead.deletedAt ?? null,
    )
    .run();
};

test('lead list filters, excludes deleted rows, pages, and hints duplicates', async () => {
  const fx = await startFixture();
  try {
    const newest = ms(1_000);
    await insertLead(fx.db, {
      createdAt: newest,
      email: 'dup@example.test',
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
      name: 'Newest',
    });
    await insertLead(fx.db, {
      createdAt: ms(2_000),
      email: 'dup@example.test',
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
      name: 'Middle Acme',
    });
    await insertLead(fx.db, {
      createdAt: ms(3_000),
      email: 'unique@example.test',
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB2',
      name: 'Oldest',
    });
    await insertLead(fx.db, {
      createdAt: ms(4_000),
      deletedAt: ms(3_500),
      email: 'deleted@example.test',
      id: '01ARZ3NDEKTSV4RRFFQ69G5FB3',
      name: 'Deleted',
    });

    const first = await fx.api(`/v1/leads?pipelineId=${PIPELINE}&limit=2`);
    expect(first.status, JSON.stringify(first)).toBe(200);
    const firstPage = first.json.data as Array<Record<string, unknown>>;
    expect(firstPage.map((lead) => lead['name'])).toEqual([
      'Newest',
      'Middle Acme',
    ]);
    expect(firstPage.map((lead) => lead['duplicateCount'])).toEqual([1, 1]);
    expect(typeof first.json.nextCursor).toBe('string');

    const cursor = encodeURIComponent(String(first.json.nextCursor));
    const second = await fx.api(
      `/v1/leads?pipelineId=${PIPELINE}&limit=2&cursor=${cursor}`,
    );
    expect(second.status, JSON.stringify(second)).toBe(200);
    expect(
      (second.json.data as Array<Record<string, unknown>>).map(
        (lead) => lead['name'],
      ),
    ).toEqual(['Oldest']);
    expect(second.json.nextCursor).toBeNull();

    const search = await fx.api(`/v1/leads?pipelineId=${PIPELINE}&query=Acme`);
    expect(search.status, JSON.stringify(search)).toBe(200);
    expect(search.json.data).toHaveLength(1);

    const counts = await fx.api(
      `/v1/leads/stage-counts?pipelineId=${PIPELINE}`,
    );
    expect(counts.status, JSON.stringify(counts)).toBe(200);
    expect(counts.json.data).toEqual([{ count: 3, stageId: STAGE }]);

    const detail = await fx.api('/v1/leads/01ARZ3NDEKTSV4RRFFQ69G5FB2');
    expect(detail.status, JSON.stringify(detail)).toBe(200);
    expect((detail.json.data as Record<string, unknown>)['name']).toBe(
      'Oldest',
    );

    const missing = await fx.api('/v1/leads/01ARZ3NDEKTSV4RRFFQ69G5FBZ');
    expect(missing.status).toBe(404);
  } finally {
    await fx.dispose();
  }
});

test('lead queries validate through Standard Schema', async () => {
  const fx = await startFixture();
  try {
    const badLimit = await fx.api('/v1/leads?limit=0');
    expect(badLimit.status).toBe(422);
    expect(badLimit.json).toMatchObject({
      code: 'validation_error',
      message: 'The request is invalid.',
    });

    const badCursor = await fx.api('/v1/leads?cursor=not-a-cursor');
    expect(badCursor.status).toBe(422);
    expect(badCursor.json).toMatchObject({ code: 'invalid_cursor' });
  } finally {
    await fx.dispose();
  }
});

test('staff routes require a session', async () => {
  const fx = await startFixture({ unauthenticated: true });
  try {
    const response = await fx.api('/v1/leads');
    expect(response.status).toBe(401);
    expect(response.json).toMatchObject({ code: 'unauthorized' });
  } finally {
    await fx.dispose();
  }
});

test('leads can be created, updated, moved, deleted, and annotated', async () => {
  const fx = await startFixture();
  try {
    const created = await fx.api('/v1/leads', 'POST', {
      email: 'manual@example.test',
      firstName: 'Manual',
      name: 'Manual lead',
      source: 'Manual entry',
    });
    expect(created.status, JSON.stringify(created)).toBe(201);
    const lead = created.json.data as {
      id: string;
      name: string;
      stageId: string;
    };
    expect(lead.name).toBe('Manual lead');

    // Identity is required for a manual lead.
    const invalid = await fx.api('/v1/leads', 'POST', { name: 'No identity' });
    expect(invalid.status).toBe(422);
    expect(invalid.json).toMatchObject({ code: 'lead_identity_required' });

    const updated = await fx.api(`/v1/leads/${lead.id}`, 'PATCH', {
      estimatedValue: 2_500,
      name: 'Renamed lead',
    });
    expect(updated.status, JSON.stringify(updated)).toBe(200);
    expect((updated.json.data as { name: string }).name).toBe('Renamed lead');

    const stage = await fx.api(`/v1/pipelines/${PIPELINE}/stages`, 'POST', {
      name: 'Qualified',
    });
    expect(stage.status, JSON.stringify(stage)).toBe(201);
    const stageId = (stage.json.data as { id: string }).id;
    const moved = await fx.api('/v1/leads/bulk', 'PATCH', {
      ids: [lead.id],
      stageId,
    });
    expect(moved.status, JSON.stringify(moved)).toBe(200);
    const detail = await fx.api(`/v1/leads/${lead.id}`);
    expect((detail.json.data as { stageId: string }).stageId).toBe(stageId);

    // A stage from another pipeline is rejected without moving anything.
    const other = await fx.api('/v1/pipelines', 'POST', { name: 'Other' });
    const otherPipelineId = (other.json.data as { id: string }).id;
    const foreignStage = await fx.api(
      `/v1/pipelines/${otherPipelineId}/stages`,
      'POST',
      { name: 'Foreign' },
    );
    const foreignStageId = (foreignStage.json.data as { id: string }).id;
    const foreignMove = await fx.api('/v1/leads/bulk', 'PATCH', {
      ids: [lead.id],
      stageId: foreignStageId,
    });
    expect(foreignMove.status).toBe(422);
    expect(foreignMove.json).toMatchObject({ code: 'invalid_stage' });

    const activity = await fx.api(`/v1/leads/${lead.id}/activities`, 'POST', {
      body: 'Called them',
    });
    expect(activity.status, JSON.stringify(activity)).toBe(201);
    const activities = await fx.api(`/v1/leads/${lead.id}/activities`);
    expect(activities.json.data).toHaveLength(1);

    const deleted = await fx.api('/v1/leads/bulk-delete', 'POST', {
      ids: [lead.id],
    });
    expect(deleted.status, JSON.stringify(deleted)).toBe(200);
    const list = await fx.api('/v1/leads');
    expect(list.json.data).toHaveLength(0);
  } finally {
    await fx.dispose();
  }
});
