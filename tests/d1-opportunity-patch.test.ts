import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * D1-backed regression tests for PATCH /v1/opportunities/:id:
 *
 * - rename and estimated-value updates commit to real D1 and are visible
 *   through GET; whitespace-padded names are rejected like every other
 *   NonEmptyString field in the app;
 * - an explicit `null` clears the estimated value, while omitting the field
 *   preserves the stored value;
 * - empty payloads, whitespace-only names, wrong types, and negative values
 *   are rejected with 422 validation_error without touching the row;
 * - unknown ids return 404 not_found;
 * - unauthenticated requests return 401 unauthorized.
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

let workerScript: string | null = null;

const bundleWorker = async (): Promise<string> => {
  if (workerScript) return workerScript;
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
  workerScript = bundled.outputFiles[0].text;
  return workerScript;
};

interface Opportunity {
  contact: { email: string | null; firstName: string | null; id: string; lastName: string | null };
  customFields: Record<string, unknown>;
  estimatedValue: number | null;
  id: string;
  name: string;
  pipelineId: string;
  stageId: string;
}

interface PatchFixture {
  api(
    path: string,
    method?: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  db: D1Database;
  dispose(): Promise<void>;
  ok<T>(path: string, method: string, body?: unknown): Promise<T>;
}

/**
 * Fresh in-memory D1 fixture with drizzle/ migrations applied. Without
 * `devAdmin: false` the fixture sets DEV_ADMIN_EMAIL (ENVIRONMENT=test), so
 * every request is authenticated; with it the fixture has no identity at all,
 * which exercises the 401 path without needing the JWKS endpoint.
 */
const startFixture = async (options: { devAdmin?: boolean } = {}): Promise<PatchFixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        ...(options.devAdmin === false ? {} : { DEV_ADMIN_EMAIL: 'patch-regression@example.test' }),
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
    if (disposed) return;
    disposed = true;
    await mf.dispose();
  };
  try {
    const db = await mf.getD1Database('DB');
    const names = (await readdir(join(repoRoot, 'drizzle')))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of names) {
      const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    const api = async (
      path: string,
      method = 'GET',
      body?: unknown,
    ): Promise<{ status: number; json: Record<string, unknown> }> => {
      const response = await mf.dispatchFetch(`https://patch-test.example${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }
      return { status: response.status, json };
    };
    const ok = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
      const result = await api(path, method, body);
      expect(
        result.status >= 200 && result.status < 300,
        `${method} ${path} -> ${result.status}: ${JSON.stringify(result)}`,
      ).toBe(true);
      return result.json.data as T;
    };
    return { api, db, dispose, ok };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const createOpportunity = async (
  f: PatchFixture,
  name = 'Patch me',
  estimatedValue?: number | null,
): Promise<Opportunity> => {
  const contact = await f.ok<{ id: string }>('/v1/contacts', 'POST', {
    email: 'patch@example.test',
    firstName: 'Patch',
  });
  return f.ok<Opportunity>('/v1/opportunities', 'POST', {
    contactId: contact.id,
    name,
    ...(estimatedValue === undefined ? {} : { estimatedValue }),
  });
};

const opportunityRow = (f: PatchFixture, id: string) =>
  f.db
    .prepare(
      'SELECT name, estimated_value, pipeline_id, stage_id, updated_at FROM opportunities WHERE id = ?',
    )
    .bind(id)
    .first();

test('PATCH renames an opportunity and leaves other fields intact', async () => {
  const f = await startFixture();
  try {
    const opportunity = await createOpportunity(f, 'Original deal', 250);
    const before = (await opportunityRow(f, opportunity.id)) as Record<string, string | number | null>;

    const result = await f.api(`/v1/opportunities/${opportunity.id}`, 'PATCH', {
      name: 'Renamed deal',
    });
    expect(result.status, JSON.stringify(result)).toBe(200);
    const updated = result.json.data as Opportunity;
    expect(updated.name).toBe('Renamed deal');
    expect(updated.estimatedValue).toBe(250);
    expect(updated.pipelineId).toBe(opportunity.pipelineId);
    expect(updated.stageId).toBe(opportunity.stageId);
    expect(updated.contact.id).toBe(opportunity.contact.id);
    expect(updated.customFields).toEqual(opportunity.customFields);

    const row = (await opportunityRow(f, opportunity.id)) as Record<string, string | number | null>;
    expect(row.name).toBe('Renamed deal');
    expect(row.estimated_value).toBe(250);
    expect(row.pipeline_id).toBe(opportunity.pipelineId);
    expect(row.stage_id).toBe(opportunity.stageId);
    await tick();
    const again = await f.api(`/v1/opportunities/${opportunity.id}`, 'PATCH', { name: 'Renamed deal' });
    expect(again.status).toBe(200);
    const after = (await opportunityRow(f, opportunity.id)) as Record<string, string | number | null>;
    expect(after.updated_at, 'updated_at must move forward on update').not.toBe(before.updated_at);

    const read = await f.ok<Opportunity>('/v1/opportunities/' + opportunity.id, 'GET');
    expect(read.name).toBe('Renamed deal');
    expect(read.estimatedValue).toBe(250);
  } finally {
    await f.dispose();
  }
});

test('PATCH updates the estimated value, and explicit null clears it while omission preserves it', async () => {
  const f = await startFixture();
  try {
    const opportunity = await createOpportunity(f, 'Value deal', 100);

    const set = await f.api(`/v1/opportunities/${opportunity.id}`, 'PATCH', { estimatedValue: 1234.5 });
    expect(set.status, JSON.stringify(set)).toBe(200);
    expect((set.json.data as Opportunity).estimatedValue).toBe(1234.5);
    expect((await opportunityRow(f, opportunity.id))?.estimated_value).toBe(1234.5);

    const clear = await f.api(`/v1/opportunities/${opportunity.id}`, 'PATCH', { estimatedValue: null });
    expect(clear.status, JSON.stringify(clear)).toBe(200);
    expect((clear.json.data as Opportunity).estimatedValue).toBeNull();
    expect((await opportunityRow(f, opportunity.id))?.estimated_value).toBeNull();

    // Omitting the field keeps the (null) value: a rename must not touch it.
    const keep = await f.api(`/v1/opportunities/${opportunity.id}`, 'PATCH', { name: 'Kept' });
    expect(keep.status, JSON.stringify(keep)).toBe(200);
    const data = keep.json.data as Opportunity;
    expect(data.name).toBe('Kept');
    expect(data.estimatedValue).toBeNull();
    expect((await opportunityRow(f, opportunity.id))?.estimated_value).toBeNull();
  } finally {
    await f.dispose();
  }
});

test('PATCH updates name and estimated value in one request', async () => {
  const f = await startFixture();
  try {
    const opportunity = await createOpportunity(f, 'Both', 10);
    const result = await f.api(`/v1/opportunities/${opportunity.id}`, 'PATCH', {
      estimatedValue: 77.25,
      name: 'Both updated',
    });
    expect(result.status, JSON.stringify(result)).toBe(200);
    const data = result.json.data as Opportunity;
    expect(data.name).toBe('Both updated');
    expect(data.estimatedValue).toBe(77.25);
  } finally {
    await f.dispose();
  }
});

test('PATCH rejects empty payloads, blank names, and invalid values with 422 without touching the row', async () => {
  const f = await startFixture();
  try {
    const opportunity = await createOpportunity(f, 'Untouched', 42);

    const bodies = [
      {},
      { name: '   ' },
      { name: '' },
      { name: '  padded  ' },
      { estimatedValue: -1 },
      { estimatedValue: '500' },
      { estimatedValue: null, name: 7 },
      { unrelated: true },
    ];
    for (const body of bodies) {
      const result = await f.api(`/v1/opportunities/${opportunity.id}`, 'PATCH', body);
      expect(result.status, JSON.stringify(result)).toBe(422);
      expect(result.json.code, JSON.stringify(result)).toBe('validation_error');
      expect(typeof result.json.message, JSON.stringify(result)).toBe('string');
    }

    const row = (await opportunityRow(f, opportunity.id)) as Record<string, string | number | null>;
    expect(row.name).toBe('Untouched');
    expect(row.estimated_value).toBe(42);
  } finally {
    await f.dispose();
  }
});

test('PATCH returns 404 not_found for unknown opportunities and writes nothing', async () => {
  const f = await startFixture();
  try {
    const unknown = await f.api('/v1/opportunities/01ARZ3NDEKTSV4RRFFQ69G5FC9', 'PATCH', { name: 'Ghost' });
    expect(unknown.status, JSON.stringify(unknown)).toBe(404);
    expect(unknown.json.code, JSON.stringify(unknown)).toBe('not_found');
    expect(typeof unknown.json.message).toBe('string');

    const malformed = await f.api('/v1/opportunities/not-a-ulid', 'PATCH', { name: 'Ghost' });
    expect(malformed.status, JSON.stringify(malformed)).toBe(404);
    expect(malformed.json.code, JSON.stringify(malformed)).toBe('not_found');

    const count = await f.db.prepare('SELECT count(*) AS n FROM opportunities').first();
    expect(count?.n).toBe(0);
  } finally {
    await f.dispose();
  }
});

test('PATCH requires an authenticated identity (401 unauthorized)', async () => {
  const f = await startFixture({ devAdmin: false });
  try {
    const result = await f.api('/v1/opportunities/01ARZ3NDEKTSV4RRFFQ69G5FC9', 'PATCH', { name: 'Ghost' });
    expect(result.status, JSON.stringify(result)).toBe(401);
    expect(result.json.code, JSON.stringify(result)).toBe('unauthorized');
    expect(typeof result.json.message).toBe('string');

    const count = await f.db.prepare('SELECT count(*) AS n FROM opportunities').first();
    expect(count?.n).toBe(0);
  } finally {
    await f.dispose();
  }
});
