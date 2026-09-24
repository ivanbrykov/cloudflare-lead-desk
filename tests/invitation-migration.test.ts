import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Migration 0004 (invitation_foundation) coverage, applied against real
 * Miniflare D1 — the same migration files the worker fixture applies.
 *
 * Two independent databases are used:
 * - a fresh DB that applies every migration (0000..0004), to verify the
 *   new tables, the unconsumed bootstrap seed, token-hash uniqueness, the
 *   singleton CHECK, and ON DELETE SET NULL on the redemption reference;
 * - an upgrade DB that applies 0000..0003, seeds representative auth and
 *   API-token rows, then applies 0004, to verify existing rows survive
 *   byte-for-byte, the new columns start NULL, the bootstrap row is
 *   consumed when a user already exists, and rerunning only the seed
 *   statement is a no-op.
 */

const repoRoot = process.cwd();
const MIGRATION = '0004_invitation_foundation.sql';
const DAY_MS = 86_400_000;

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

const applyFile = async (database: D1Database, name: string): Promise<void> => {
  const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
  for (const statement of splitStatements(sql)) {
    await database.prepare(statement).run();
  }
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

const columnNameList = async (
  database: D1Database,
  table: string,
): Promise<string[]> =>
  (await allRows(database, `PRAGMA table_info(${table})`)).map((column) =>
    String(column.name),
  );

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

// Timestamps are ISO-8601 text before migration 0007 and Unix milliseconds
// after it; the fresh-database path applies every migration, so normalize.
const toEpochMs = (value: unknown): number =>
  typeof value === 'number' ? value : Date.parse(String(value));

const expectSevenDayGap = (createdAt: unknown, expiresAt: unknown): void => {
  const gap = toEpochMs(expiresAt) - toEpochMs(createdAt);
  expect(
    Math.abs(gap - 7 * DAY_MS),
    `created=${createdAt} expires=${expiresAt}`,
  ).toBeLessThanOrEqual(1_000);
};

test('fresh database: new tables, unconsumed bootstrap seed, uniqueness and FK behavior', async () => {
  const { db, dispose } = await startD1();
  try {
    for (const name of await listMigrations()) {
      await applyFile(db, name);
    }

    // Exact column sets, in schema order, for the two new tables.
    // Migration 0007 rebuilds both tables, so columns are in the current
    // schema (drizzle-kit) order rather than the original 0004 order.
    expect(await columnNameList(db, 'staff_invites')).toEqual([
      'created_at',
      'expires_at',
      'id',
      'name',
      'prefix',
      'revoked_at',
      'token_hash',
      'used_at',
      'used_by_user_id',
    ]);
    expect(await columnNameList(db, 'bootstrap_state')).toEqual([
      'consumed_at',
      'created_at',
      'expires_at',
      'id',
    ]);

    // Additive columns on the existing tables.
    expect(await columnNameList(db, 'api_tokens')).toContain('expires_at');
    expect(await columnNameList(db, 'user')).toContain('disabled_at');

    // Fresh install: exactly one bootstrap row, unconsumed, 7-day window.
    const fresh = await singleRow(
      db,
      "SELECT * FROM bootstrap_state WHERE id = 'default'",
    );
    expect(
      (await allRows(db, 'SELECT COUNT(*) AS n FROM bootstrap_state'))[0].n,
    ).toBe(1);
    expect(fresh.consumed_at).toBeNull();
    expectSevenDayGap(fresh.created_at, fresh.expires_at);

    // The singleton CHECK rejects any other id.
    const isoStart = Date.parse('2026-01-01T00:00:00.000Z');
    await expect(
      db
        .prepare(
          'INSERT INTO bootstrap_state (id, created_at, expires_at) VALUES (?, ?, ?)',
        )
        .bind('other', isoStart, isoStart + 7 * DAY_MS)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);

    // token_hash is unique.
    const insertInvite = (id: string) =>
      db
        .prepare(
          'INSERT INTO staff_invites (id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          'Invite',
          'sha256-of-token-a',
          'inv_ab',
          isoStart,
          isoStart + 7 * DAY_MS,
        )
        .run();
    await insertInvite('invite-1');
    await expect(insertInvite('invite-2')).rejects.toThrow(
      /UNIQUE constraint failed/u,
    );

    // Redeeming an invite points at the user; deleting the user keeps the
    // redemption row and clears the reference (ON DELETE SET NULL).
    await db.exec('PRAGMA foreign_keys = ON;');
    await db
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-invite', 'Redeemed', 'redeemed@example.test', 1, 1750000000000, 1750000000000)",
      )
      .run();
    await db
      .prepare(
        'UPDATE staff_invites SET used_at = ?, used_by_user_id = ? WHERE id = ?',
      )
      .bind(isoStart + DAY_MS, 'user-invite', 'invite-1')
      .run();
    await db.prepare("DELETE FROM user WHERE id = 'user-invite'").run();
    const survived = await singleRow(
      db,
      'SELECT * FROM staff_invites WHERE id = ?',
      'invite-1',
    );
    expect(survived.used_by_user_id).toBeNull();
    expect(survived.used_at).toBe(isoStart + DAY_MS);
  } finally {
    await dispose();
  }
});

test('upgrade database: rows preserved, bootstrap consumed, seed rerun is a no-op', async () => {
  const { db, dispose } = await startD1();
  try {
    const names = await listMigrations();
    expect(names).toContain(MIGRATION);
    // This upgrade path verifies migration 0004 itself: apply only the
    // migrations that precede it, then seed, then apply 0004.
    for (const name of names.filter((candidate) => candidate < MIGRATION)) {
      await applyFile(db, name);
    }

    // Representative pre-migration data: user, credential account, session,
    // and an API token on the default workspace seeded by migration 0002.
    await db
      .prepare(
        'INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'user-1',
        'Admin',
        'admin@example.test',
        1,
        1_750_000_000_000,
        1_750_000_000_000,
      )
      .run();
    await db
      .prepare(
        'INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'account-1',
        'cred-1',
        'credential',
        'user-1',
        'pbkdf2-sha256$hash',
        1_750_000_000_000,
        1_750_000_000_000,
      )
      .run();
    await db
      .prepare(
        'INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'session-1',
        1_750_003_600_000,
        'session-token-1',
        1_750_000_000_000,
        1_750_000_000_000,
        'user-1',
      )
      .run();
    await db
      .prepare(
        'INSERT INTO api_tokens (id, name, prefix, token_hash, scope, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'token-1',
        'ci',
        'cld_ci',
        'api-hash-1',
        'intake:write',
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        '2026-05-01T00:00:00.000Z',
      )
      .run();

    // Snapshot the pre-migration rows. The user snapshot uses the old column
    // set only, so the post-migration comparison proves nothing but the new
    // columns changed.
    const beforeUser = await singleRow(
      db,
      'SELECT id, name, email, email_verified, image, created_at, updated_at FROM user WHERE id = ?',
      'user-1',
    );
    const beforeAccount = await singleRow(
      db,
      'SELECT * FROM account WHERE id = ?',
      'account-1',
    );
    const beforeSession = await singleRow(
      db,
      'SELECT * FROM session WHERE id = ?',
      'session-1',
    );
    const beforeToken = await singleRow(
      db,
      'SELECT id, name, prefix, token_hash, scope, workspace_id, created_at, last_used_at, revoked_at FROM api_tokens WHERE id = ?',
      'token-1',
    );

    await applyFile(db, MIGRATION);

    // Existing rows survive byte-for-byte.
    expect(
      await singleRow(
        db,
        'SELECT id, name, email, email_verified, image, created_at, updated_at FROM user WHERE id = ?',
        'user-1',
      ),
    ).toEqual(beforeUser);
    expect(
      await singleRow(db, 'SELECT * FROM account WHERE id = ?', 'account-1'),
    ).toEqual(beforeAccount);
    expect(
      await singleRow(db, 'SELECT * FROM session WHERE id = ?', 'session-1'),
    ).toEqual(beforeSession);
    expect(
      await singleRow(
        db,
        'SELECT id, name, prefix, token_hash, scope, workspace_id, created_at, last_used_at, revoked_at FROM api_tokens WHERE id = ?',
        'token-1',
      ),
    ).toEqual(beforeToken);

    // The additive columns exist and are NULL on pre-existing rows.
    const afterUser = await singleRow(
      db,
      'SELECT * FROM user WHERE id = ?',
      'user-1',
    );
    expect(afterUser.disabled_at).toBeNull();
    expect(
      (await singleRow(db, 'SELECT * FROM api_tokens WHERE id = ?', 'token-1'))
        .expires_at,
    ).toBeNull();

    // A user existed at migration time: the bootstrap row is consumed, with
    // created_at == consumed_at (migration timestamp) and a 7-day window.
    const boot = await singleRow(
      db,
      "SELECT * FROM bootstrap_state WHERE id = 'default'",
    );
    expect(boot.consumed_at).not.toBeNull();
    expect(boot.consumed_at).toBe(boot.created_at);
    expectSevenDayGap(boot.created_at, boot.expires_at);

    // Rerunning only the seed statement must not refresh or reopen it.
    const statements = splitStatements(
      await readFile(join(repoRoot, 'drizzle', MIGRATION), 'utf8'),
    );
    const seed = statements.find((statement) =>
      statement.includes('INSERT OR IGNORE INTO bootstrap_state'),
    );
    if (seed === undefined) {
      throw new Error('0004 must contain the bootstrap_state seed statement');
    }

    await db.prepare(seed).run();
    expect(
      await singleRow(db, "SELECT * FROM bootstrap_state WHERE id = 'default'"),
    ).toEqual(boot);
  } finally {
    await dispose();
  }
});
