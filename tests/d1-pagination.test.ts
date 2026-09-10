import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';

/**
 * D1-backed regression tests for the Stage 3a-ii list endpoints:
 *
 * - keyset pagination of GET /v1/contacts (no overlap, no omission,
 *   strict parameter and cursor validation, search composition, and
 *   (createdAt, id) ordering with the id tie-break),
 * - the GET /v1/opportunities pipelineId filter, and
 * - batched custom-field reads for result sets larger than one D1
 *   100-bound-parameter chunk.
 *
 * The worker is bundled the same way as the external verifier and runs in
 * Miniflare against a real local D1 database (migrations applied from
 * drizzle/). Every test gets a fresh database, so tests are independently
 * runnable in any order.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `D1 regression tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

const DEFAULT_WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const DEFAULT_PIPELINE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const DEFAULT_STAGE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

interface ContactItem {
  createdAt: string;
  customFields: Record<string, unknown>;
  data: { id: string };
  email: string | null;
  firstName: string | null;
  id: string;
  lastName: string | null;
}

interface ListBody {
  data: ContactItem[];
  nextCursor: string | null;
}

interface OpportunityItem {
  customFields: Record<string, unknown>;
  id: string;
  name: string;
  pipelineId: string;
}

interface OpportunityListBody {
  data: OpportunityItem[];
}

let workerScript: string;
let miniflare: Miniflare;
let db: D1Database;

const api = async (
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number } & Record<string, unknown>> => {
  const response = await miniflare.dispatchFetch('https://lead-desk.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = { raw: raw.slice(0, 200) };
  }
  return { status: response.status, ...json };
};

const ok = async <T>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> => {
  const result = await api(path, method, body, headers);
  expect(
    result.status >= 200 && result.status < 300,
    `${method} ${path} -> ${result.status}: ${JSON.stringify(result)}`,
  ).toBe(true);
  return result.data as T;
};

const pad = (value: number) => String(value).padStart(24, '0');
const ts = (offsetSeconds: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds)).toISOString();

/** Inserts contacts directly (fast) with unique created_at values in i order. */
const seedContacts = async (count: number, prefix: string): Promise<string[]> => {
  const ids: string[] = [];
  const stmts = [];
  for (let i = 0; i < count; i += 1) {
    const contactId = prefix + pad(i);
    ids.push(contactId);
    stmts.push(
      db
        .prepare(
          'INSERT INTO contacts (id,workspace_id,first_name,last_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        )
        .bind(
          contactId,
          DEFAULT_WORKSPACE_ID,
          'Name' + i,
          'Family' + i,
          prefix + i + '@example.test',
          ts(i),
          ts(i),
        ),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return ids;
};

/** Inserts opportunities (and their contacts) directly for bulk reads. */
const seedOpportunities = async (count: number): Promise<string[]> => {
  const ids: string[] = [];
  const stmts = [];
  for (let i = 0; i < count; i += 1) {
    const contactId = 'oc' + pad(i);
    const opportunityId = 'op' + pad(i);
    ids.push(opportunityId);
    stmts.push(
      db
        .prepare(
          'INSERT INTO contacts (id,workspace_id,first_name,last_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        )
        .bind(contactId, DEFAULT_WORKSPACE_ID, 'Owner' + i, 'F' + i, 'o' + i + '@example.test', ts(i), ts(i)),
      db
        .prepare(
          'INSERT INTO opportunities (id,workspace_id,primary_contact_id,pipeline_id,stage_id,name,source,estimated_value,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          opportunityId,
          DEFAULT_WORKSPACE_ID,
          contactId,
          DEFAULT_PIPELINE_ID,
          DEFAULT_STAGE_ID,
          'Opp ' + i,
          'manual',
          null,
          ts(i),
          ts(i),
        ),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return ids;
};

/** Inserts one custom-field value per entity id, with the value derived from the id. */
const seedValues = async (
  entityType: 'contact' | 'opportunity',
  fieldId: string,
  entityIds: string[],
) => {
  const stmts = entityIds.map((entityId) =>
    db
      .prepare(
        'INSERT INTO custom_field_values (id,workspace_id,entity_type,entity_id,field_definition_id,value_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .bind(
        'v_' + entityType + '_' + entityId,
        DEFAULT_WORKSPACE_ID,
        entityType,
        entityId,
        fieldId,
        entityId,
        ts(0),
        ts(0),
      ),
  );
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
};

const b64url = (value: string) => Buffer.from(value).toString('base64url');

beforeAll(async () => {
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
}, 60_000);

beforeEach(async () => {
  miniflare = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        DEV_ADMIN_EMAIL: 'regression@example.test',
        ENVIRONMENT: 'test',
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script: workerScript,
    }),
  );
  db = await miniflare.getD1Database('DB');
  const names = (await readdir(join(repoRoot, 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names) {
    const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}, 60_000);

afterEach(async () => {
  await miniflare?.dispose();
}, 30_000);

test('keyset pagination walks every contact exactly once', async () => {
  await seedContacts(120, 'c');

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let previous: { createdAt: string; id: string } | null = null;
  do {
    const qs = '?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const body = (await api('/v1/contacts' + qs)) as unknown as { status: number } & ListBody;
    expect(body.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.length).toBeLessThanOrEqual(50);
    expect('nextCursor' in body).toBe(true);
    for (const item of body.data) {
      expect(item.data.id).toBe(item.id);
      expect(item.customFields).toEqual({});
      if (previous) {
        const ordered =
          item.createdAt < previous.createdAt ||
          (item.createdAt === previous.createdAt && item.id < previous.id);
        expect(ordered, `${item.id} vs ${previous.id}`).toBe(true);
      }
      previous = { createdAt: item.createdAt, id: item.id };
    }
    seen.push(...body.data.map((item) => item.id));
    cursor = body.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);

  expect(pages, '120 contacts at limit 50 must take 3 pages').toBe(3);
  expect(seen.length).toBe(120);
  expect(new Set(seen).size, 'duplicate or missing rows across pages').toBe(120);

  const first = (await api('/v1/contacts')) as unknown as { status: number } & ListBody;
  expect(first.status).toBe(200);
  expect(first.data.length, 'default limit must be 50').toBe(50);
  expect(typeof first.nextCursor).toBe('string');
});

test('pagination parameters are validated', async () => {
  await seedContacts(120, 'c');

  for (const limit of ['0', '101', 'abc', '1.5', '']) {
    const result = await api('/v1/contacts?limit=' + limit);
    expect(result.status, `limit=${limit}`).toBe(422);
    expect(result.code, `limit=${limit}`).toBe('validation_error');
  }

  const one = (await api('/v1/contacts?limit=1')) as unknown as ListBody;
  expect(one.data.length).toBe(1);
  expect(typeof one.nextCursor).toBe('string');

  const hundred = (await api('/v1/contacts?limit=100')) as unknown as ListBody;
  expect(hundred.data.length).toBe(100);
  expect(typeof hundred.nextCursor).toBe('string');

  const tampered = await api('/v1/contacts?cursor=tampered-nonsense');
  expect(tampered.status).toBe(422);
  expect(tampered.code).toBe('invalid_cursor');

  const empty = await api('/v1/contacts?cursor=');
  expect(empty.status).toBe(422);
  expect(empty.code).toBe('invalid_cursor');

  // Well-formed base64url payloads that are not the expected keyset shape.
  const malformed = [
    b64url('not json at all'),
    b64url('["zeta"]'),
    b64url('{"v":1}'),
    b64url('{"v":2,"c":"2026-01-01T00:00:00.000Z","i":"c000000000000000000000000000"}'),
    b64url('{"v":1,"c":"yesterday","i":"c000000000000000000000000000"}'),
    b64url('{"v":1,"c":"2026-01-01T00:00:00.000Z","i":""}'),
  ];
  for (const cursor of malformed) {
    const result = await api('/v1/contacts?cursor=' + cursor);
    expect(result.status, `cursor=${cursor}`).toBe(422);
    expect(result.code, `cursor=${cursor}`).toBe('invalid_cursor');
  }
});

test('search composes with pagination', async () => {
  await seedContacts(75, 'match');
  await seedContacts(30, 'other');

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const qs =
      '?query=' +
      encodeURIComponent('match@example.test') +
      '&limit=40' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const body = (await api('/v1/contacts' + qs)) as unknown as { status: number } & ListBody;
    expect(body.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.length).toBeLessThanOrEqual(40);
    seen.push(...body.data.map((item) => item.id));
    cursor = body.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);

  expect(seen.length).toBe(75);
  expect(new Set(seen).size, 'duplicate or missing rows across pages').toBe(75);

  const rest = (await api(
    '/v1/contacts?query=' + encodeURIComponent('other@example.test'),
  )) as unknown as ListBody;
  expect(rest.data.length).toBe(30);
  expect(rest.nextCursor).toBeNull();
});

test('search without @ keeps literal substring semantics', async () => {
  await ok('/v1/contacts', 'POST', { email: 'uno@example.test', firstName: 'Quartz' });
  await ok('/v1/contacts', 'POST', { email: 'dos@example.test', firstName: 'Quartzite' });
  await ok('/v1/contacts', 'POST', { email: 'tres@example.test', firstName: 'Beryl' });

  const sub = (await api(
    '/v1/contacts?query=' + encodeURIComponent('Quartz'),
  )) as unknown as { status: number } & ListBody;
  expect(sub.status).toBe(200);
  expect(sub.data.map((item) => item.firstName).sort()).toEqual(['Quartz', 'Quartzite']);

  // Literal characters stay literal: an unescaped '%' would match 'Quartz'.
  const literal = (await api(
    '/v1/contacts?query=' + encodeURIComponent('Q%a'),
  )) as unknown as { status: number } & ListBody;
  expect(literal.status).toBe(200);
  expect(literal.data).toEqual([]);

  // An '@' query is an email prefix search and does not match names.
  const emailOnly = (await api(
    '/v1/contacts?query=Quartz%40example.test',
  )) as unknown as { status: number } & ListBody;
  expect(emailOnly.status).toBe(200);
  expect(emailOnly.data).toEqual([]);
});

test('equal createdAt ties order by id DESC and keep paging across ties', async () => {
  const fixed = ts(0);
  for (const name of ['beta', 'alpha', 'delta', 'gamma', 'zeta']) {
    await db
      .prepare(
        'INSERT INTO contacts (id,workspace_id,first_name,last_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(name, DEFAULT_WORKSPACE_ID, 'Tie', 'Name', name + '@example.test', fixed, fixed)
      .run();
  }

  const all = (await api('/v1/contacts?limit=100')) as unknown as ListBody;
  expect(all.data.map((item) => item.id)).toEqual(['zeta', 'gamma', 'delta', 'beta', 'alpha']);
  expect(all.nextCursor).toBeNull();

  const page1 = (await api('/v1/contacts?limit=2')) as unknown as ListBody;
  expect(page1.data.map((item) => item.id)).toEqual(['zeta', 'gamma']);
  expect(typeof page1.nextCursor).toBe('string');
  const page2 = (await api(
    '/v1/contacts?limit=2&cursor=' + encodeURIComponent(page1.nextCursor!),
  )) as unknown as ListBody;
  expect(page2.data.map((item) => item.id)).toEqual(['delta', 'beta']);
  expect(typeof page2.nextCursor).toBe('string');
  const page3 = (await api(
    '/v1/contacts?limit=2&cursor=' + encodeURIComponent(page2.nextCursor!),
  )) as unknown as ListBody;
  expect(page3.data.map((item) => item.id)).toEqual(['alpha']);
  expect(page3.nextCursor).toBeNull();
});

test('opportunities filter by pipeline and reject unknown or archived pipelines', async () => {
  const other = await ok<{ id: string }>('/v1/pipelines', 'POST', { name: 'Second' });
  const stage = await ok<{ id: string }>('/v1/pipelines/' + other.id + '/stages', 'POST', {
    name: 'Stage A',
  });
  const contact = await ok<{ id: string }>('/v1/contacts', 'POST', {
    email: 'pipeline@example.test',
  });
  await ok('/v1/opportunities', 'POST', { contactId: contact.id, name: 'Default deal' });
  await ok('/v1/opportunities', 'POST', {
    contactId: contact.id,
    name: 'Second deal',
    pipelineId: other.id,
    stageId: stage.id,
  });

  const all = (await api('/v1/opportunities')) as unknown as { status: number } & OpportunityListBody;
  expect(all.status).toBe(200);
  expect(all.data.length).toBe(2);

  const filtered = (await api(
    '/v1/opportunities?pipelineId=' + other.id,
  )) as unknown as OpportunityListBody;
  expect(filtered.data.length).toBe(1);
  expect(filtered.data[0].name).toBe('Second deal');

  const defaultOnly = (await api(
    '/v1/opportunities?pipelineId=' + DEFAULT_PIPELINE_ID,
  )) as unknown as OpportunityListBody;
  expect(defaultOnly.data.length).toBe(1);
  expect(defaultOnly.data[0].name).toBe('Default deal');

  const unknown = await api('/v1/opportunities?pipelineId=01ARZ3NDEKTSV4RRFFQ69G5FC9');
  expect(unknown.status).toBe(422);
  expect(unknown.code).toBe('validation_error');

  // Archived pipelines are rejected by the filter as well.
  await db
    .prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?')
    .bind(ts(0), other.id)
    .run();
  const archived = await api('/v1/opportunities?pipelineId=' + other.id);
  expect(archived.status).toBe(422);
  expect(archived.code).toBe('validation_error');
});

test('batched custom-field reads cover more entities than one D1 bind limit', async () => {
  const field = await ok<{ id: string }>('/v1/custom-fields', 'POST', {
    entityType: 'contact',
    key: 'tier',
    label: 'Tier',
    type: 'text',
  });
  const contactIds = await seedContacts(120, 'c');
  await seedValues('contact', field.id, contactIds);

  // 100 ids per page cross the 99-id chunk boundary (100 = 99 + 1 chunks).
  const page1 = (await api('/v1/contacts?limit=100')) as unknown as ListBody;
  expect(page1.data.length).toBe(100);
  for (const item of page1.data) {
    expect(item.customFields.tier, item.id).toBe(item.id);
  }
  expect(typeof page1.nextCursor).toBe('string');

  const page2 = (await api(
    '/v1/contacts?limit=100&cursor=' + encodeURIComponent(page1.nextCursor!),
  )) as unknown as ListBody;
  expect(page2.data.length).toBe(20);
  for (const item of page2.data) {
    expect(item.customFields.tier, item.id).toBe(item.id);
  }
  expect(page2.nextCursor).toBeNull();

  const opportunityField = await ok<{ id: string }>('/v1/custom-fields', 'POST', {
    entityType: 'opportunity',
    key: 'priority',
    label: 'Priority',
    type: 'text',
  });
  const opportunityIds = await seedOpportunities(105);
  await seedValues('opportunity', opportunityField.id, opportunityIds);

  // 105 ids cross the boundary as 99 + 6 chunks.
  const opportunities = (await api('/v1/opportunities')) as unknown as OpportunityListBody;
  expect(opportunities.data.length).toBe(105);
  for (const item of opportunities.data) {
    expect(item.customFields.priority, item.id).toBe(item.id);
  }
});
