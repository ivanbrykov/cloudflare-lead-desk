import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Migration 0007 coverage: every app-owned timestamp column moves from
 * ISO-8601 text to Unix milliseconds (`timestamp_ms`, matching Better Auth).
 *
 * - Fresh DB: every migration applies per statement (the worker fixtures'
 *   path), the rebuilt columns have INTEGER affinity, bootstrap timestamps
 *   are converted milliseconds, the grant-guard trigger and named indexes
 *   survive, and foreign keys stay clean.
 * - Upgrade DB: 0000..0006 apply, representative ISO rows are seeded across
 *   every rebuilt table, then 0007 applies as one transaction (the wrangler /
 *   D1 migration path). Rows convert losslessly at millisecond precision,
 *   nullable timestamps stay null, no `__old_*` tables remain,
 *   `PRAGMA foreign_key_check` is empty, and the recreated trigger still
 *   rejects an ineligible claim.
 */

const repoRoot = process.cwd();
const MIGRATION = '0007_melted_nehzno.sql';
const DAY_MS = 86_400_000;
const ISO_BASE = '2026-05-01T10:00:00.123Z';
const ISO_ARCHIVED = '2026-05-02T11:22:33.456Z';
const ISO_DELETED = '2026-05-03T12:34:56.789Z';

type Row = Record<string, unknown>;

const listMigrations = async (): Promise<string[]> =>
  (await readdir(join(repoRoot, 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .toSorted();

const splitStatements = (sql: string): string[] =>
  sql
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter(Boolean);

const migrationSql = async (name: string): Promise<string> =>
  readFile(join(repoRoot, 'drizzle', name), 'utf8');

const applyFile = async (database: D1Database, name: string): Promise<void> => {
  for (const statement of splitStatements(await migrationSql(name))) {
    await database.prepare(statement).run();
  }
};

const applyFileAtomically = async (
  database: D1Database,
  name: string,
): Promise<void> => {
  const statements = splitStatements(await migrationSql(name)).map((sql) =>
    database.prepare(sql),
  );
  await database.batch(statements);
};

const allRows = async (
  database: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<Row[]> => {
  const { results } = await database
    .prepare(sql)
    .bind(...binds)
    .all<Row>();
  return results;
};

const singleRow = async (
  database: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<Row> => {
  const rows = await allRows(database, sql, ...binds);
  expect(rows.length, `expected exactly one row for: ${sql}`).toBe(1);
  return rows[0];
};

const columnByName = async (
  database: D1Database,
  table: string,
  column: string,
): Promise<Row> => {
  const columns = await allRows(database, `PRAGMA table_info(${table})`);
  const found = columns.find((candidate) => candidate.name === column);
  expect(found, `${table}.${column} must exist`).toBeDefined();
  return found as Row;
};

const startD1 = async (): Promise<{
  db: D1Database;
  dispose: () => Promise<void>;
}> => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-08-22',
      d1Databases: ['DB'],
      modules: true,
      // D1-only fixture: an empty module keeps the v4 options valid without
      // bundling the real worker (the worker script is never dispatched to).
      script: 'export default {};',
    }),
  );
  const database = await mf.getD1Database('DB');
  return { db: database, dispose: () => mf.dispose() };
};

test('fresh database: rebuilt columns, bootstrap conversion, indexes and trigger survive', async () => {
  const { db, dispose } = await startD1();
  try {
    for (const name of await listMigrations()) {
      await applyFile(db, name);
    }

    // Every rebuilt timestamp column has INTEGER affinity.
    for (const [table, column] of [
      ['workspaces', 'created_at'],
      ['pipelines', 'archived_at'],
      ['contacts', 'updated_at'],
      ['opportunities', 'deleted_at'],
      ['custom_field_values', 'updated_at'],
      ['api_tokens', 'revoked_at'],
      ['staff_invites', 'expires_at'],
      ['bootstrap_state', 'consumed_at'],
      ['registration_claims', 'created_at'],
      ['idempotency_keys', 'created_at'],
    ] as const) {
      const info = await columnByName(db, table, column);
      expect(String(info.type).toUpperCase(), `${table}.${column}`).toBe(
        'INTEGER',
      );
    }

    // The bootstrap rows were written as ISO text by migrations 0002/0004 and
    // are now Unix milliseconds.
    const bootstrap = await singleRow(
      db,
      'SELECT created_at, typeof(created_at) AS type FROM workspaces',
    );
    expect(bootstrap.type).toBe('integer');
    expect(bootstrap.created_at).toBe(Date.parse('2026-01-01T00:00:00.000Z'));

    const grant = await singleRow(
      db,
      'SELECT consumed_at, created_at, expires_at FROM bootstrap_state',
    );
    expect(grant.consumed_at).toBeNull();
    expect(typeof grant.created_at).toBe('number');
    expect(typeof grant.expires_at).toBe('number');
    expect((grant.expires_at as number) - (grant.created_at as number)).toBe(
      7 * DAY_MS,
    );

    expect(await allRows(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(
      await allRows(
        db,
        "SELECT name FROM sqlite_master WHERE name LIKE '__old_%'",
      ),
    ).toEqual([]);

    const trigger = await singleRow(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'registration_claims_grant_guard'",
    );
    expect(trigger.name).toBe('registration_claims_grant_guard');

    const indexes = await allRows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('contacts_workspace_created_idx','stages_pipeline_position_unique','registration_claims_claim_key_unique','workspaces_slug_unique') ORDER BY name",
    );
    expect(indexes.map((row) => row.name)).toEqual([
      'contacts_workspace_created_idx',
      'registration_claims_claim_key_unique',
      'stages_pipeline_position_unique',
      'workspaces_slug_unique',
    ]);
  } finally {
    await dispose();
  }
});

test('upgrade database: ISO rows convert losslessly and integrity survives one-transaction apply', async () => {
  const { db, dispose } = await startD1();
  try {
    for (const name of await listMigrations()) {
      if (name !== MIGRATION) {
        await applyFile(db, name);
      }
    }

    // Representative legacy rows across every rebuilt table, all timestamps
    // in the pre-0007 ISO-8601 format.
    await db.batch([
      db
        .prepare(
          'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind('ws2', 'second', 'Second', ISO_BASE, ISO_BASE),
      db
        .prepare(
          'INSERT INTO contacts (id, workspace_id, email, normalized_email, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'c2',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'legacy@example.test',
          'legacy@example.test',
          'Legacy',
          'Contact',
          ISO_BASE,
          ISO_BASE,
        ),
      db
        .prepare(
          'INSERT INTO pipelines (id, workspace_id, name, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'p2',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'Legacy pipeline',
          ISO_ARCHIVED,
          ISO_BASE,
          ISO_BASE,
        ),
      db
        .prepare(
          'INSERT INTO stages (id, workspace_id, pipeline_id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          's2',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'p2',
          'Legacy stage',
          'slate',
          0,
          ISO_BASE,
          ISO_BASE,
        ),
      db
        .prepare(
          'INSERT INTO opportunities (id, workspace_id, primary_contact_id, pipeline_id, stage_id, name, source, estimated_value, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'o2',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'c2',
          'p2',
          's2',
          'Legacy deal',
          'manual',
          1_234,
          ISO_BASE,
          ISO_BASE,
          ISO_DELETED,
        ),
      db
        .prepare(
          'INSERT INTO activities (id, workspace_id, contact_id, opportunity_id, kind, body, actor_email, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'a2',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'c2',
          'o2',
          'note',
          'Legacy note',
          'legacy@example.test',
          '{}',
          ISO_BASE,
        ),
      db
        .prepare(
          'INSERT INTO custom_field_definitions (id, workspace_id, entity_type, key, label, options, required, type, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'f2',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'opportunity',
          'legacy_segment',
          'Legacy segment',
          '[]',
          0,
          'text',
          ISO_ARCHIVED,
          ISO_BASE,
          ISO_BASE,
        ),
      db
        .prepare(
          'INSERT INTO custom_field_values (id, workspace_id, entity_type, entity_id, field_definition_id, value_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'v2',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'opportunity',
          'o2',
          'f2',
          'Enterprise',
          ISO_BASE,
          ISO_BASE,
        ),
      db
        .prepare(
          'INSERT INTO api_tokens (id, workspace_id, name, prefix, token_hash, scope, expires_at, last_used_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          't2',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'Legacy token',
          'cld_legacy',
          'legacy-hash',
          'intake:write',
          ISO_BASE,
          ISO_ARCHIVED,
          null,
          ISO_BASE,
        ),
      db
        .prepare(
          'INSERT INTO staff_invites (id, name, token_hash, prefix, created_at, expires_at, used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'i2',
          'Legacy invite',
          'legacy-invite-hash',
          'cld_invite',
          ISO_BASE,
          ISO_ARCHIVED,
          null,
          null,
        ),
      db
        .prepare(
          'INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'rc2',
          'bootstrap',
          'bootstrap',
          'bootstrap-claim-2',
          null,
          ISO_BASE,
        ),
    ]);

    await applyFileAtomically(db, MIGRATION);

    // Lossless millisecond conversion, including the fractional part.
    const converted = await singleRow(
      db,
      'SELECT created_at, typeof(created_at) AS type FROM contacts WHERE id = ?',
      'c2',
    );
    expect(converted.type).toBe('integer');
    expect(converted.created_at).toBe(Date.parse(ISO_BASE));
    expect((converted.created_at as number) % 1_000).toBe(123);

    const opportunity = await singleRow(
      db,
      'SELECT deleted_at, updated_at FROM opportunities WHERE id = ?',
      'o2',
    );
    expect(opportunity.deleted_at).toBe(Date.parse(ISO_DELETED));
    expect(opportunity.updated_at).toBe(Date.parse(ISO_BASE));

    const pipeline = await singleRow(
      db,
      'SELECT archived_at FROM pipelines WHERE id = ?',
      'p2',
    );
    expect(pipeline.archived_at).toBe(Date.parse(ISO_ARCHIVED));

    const value = await singleRow(
      db,
      'SELECT value_text, updated_at FROM custom_field_values WHERE id = ?',
      'v2',
    );
    expect(value.value_text).toBe('Enterprise');
    expect(value.updated_at).toBe(Date.parse(ISO_BASE));

    // Nullable timestamps that were null stay null; non-null converts.
    const token = await singleRow(
      db,
      'SELECT revoked_at, last_used_at FROM api_tokens WHERE id = ?',
      't2',
    );
    expect(token.revoked_at).toBeNull();
    expect(token.last_used_at).toBe(Date.parse(ISO_ARCHIVED));

    const invite = await singleRow(
      db,
      'SELECT used_at, revoked_at, expires_at FROM staff_invites WHERE id = ?',
      'i2',
    );
    expect(invite.used_at).toBeNull();
    expect(invite.revoked_at).toBeNull();
    expect(invite.expires_at).toBe(Date.parse(ISO_ARCHIVED));

    const claim = await singleRow(
      db,
      'SELECT created_at FROM registration_claims WHERE id = ?',
      'rc2',
    );
    expect(claim.created_at).toBe(Date.parse(ISO_BASE));

    const bootstrap = await singleRow(
      db,
      'SELECT created_at, expires_at FROM bootstrap_state',
    );
    expect(typeof bootstrap.created_at).toBe('number');
    expect(
      (bootstrap.expires_at as number) - (bootstrap.created_at as number),
    ).toBe(7 * DAY_MS);

    // Integrity: no dangling references, no leftover shadow tables, and the
    // recreated trigger still rejects a claim without an eligible grant.
    expect(await allRows(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(
      await allRows(
        db,
        "SELECT name FROM sqlite_master WHERE name LIKE '__old_%'",
      ),
    ).toEqual([]);

    await expect(
      db
        .prepare(
          'INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          'rc3',
          'invite',
          'missing-grant-hash',
          'missing-grant-claim',
          null,
          Date.now(),
        )
        .run(),
    ).rejects.toThrow(/registration grant unavailable/u);
  } finally {
    await dispose();
  }
});
