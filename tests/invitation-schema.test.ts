import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Invitation schema coverage against real Miniflare D1.
 *
 * The squashed baseline is the only migration, so this exercises the final
 * schema rather than the old 0004 upgrade path: exact column sets, the
 * unconsumed 7-day bootstrap seed, the singleton CHECK, staff-invite token-hash
 * uniqueness, ON DELETE SET NULL on redemption, and the registration_claims
 * grant trigger (hand-written SQL that drizzle-kit does not generate).
 */

const repoRoot = process.cwd();
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
  const [row] = rows;
  if (row === undefined) {
    throw new Error(`expected a row for: ${sql}`);
  }

  return row;
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

const expectSevenDayGap = (createdAt: number, expiresAt: number): void => {
  expect(
    Math.abs(expiresAt - createdAt - 7 * DAY_MS),
    `created=${createdAt} expires=${expiresAt}`,
  ).toBeLessThanOrEqual(1_000);
};

test('baseline: invitation tables, bootstrap seed, constraints, and grant trigger', async () => {
  const { db, dispose } = await startD1();
  try {
    for (const name of await listMigrations()) {
      await applyFile(db, name);
    }

    // Exact column sets, in schema order.
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
    expect(await columnNameList(db, 'api_tokens')).toContain('expires_at');
    expect(await columnNameList(db, 'user')).toContain('disabled_at');

    // Fresh install: exactly one bootstrap row, unconsumed, 7-day window.
    const fresh = await singleRow(
      db,
      "SELECT * FROM bootstrap_state WHERE id = 'default'",
    );
    const bootstrapCounts = await allRows(
      db,
      'SELECT COUNT(*) AS n FROM bootstrap_state',
    );
    expect(bootstrapCounts[0]?.n).toBe(1);
    expect(fresh.consumed_at).toBeNull();
    expect(typeof fresh.created_at).toBe('number');
    expectSevenDayGap(fresh.created_at as number, fresh.expires_at as number);

    // The singleton CHECK rejects any other id.
    const now = Date.now();
    await expect(
      db
        .prepare(
          'INSERT INTO bootstrap_state (id, created_at, expires_at) VALUES (?, ?, ?)',
        )
        .bind('other', now, now + 7 * DAY_MS)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);

    // token_hash is unique.
    const insertInvite = (id: string, hash: string) =>
      db
        .prepare(
          'INSERT INTO staff_invites (id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(id, 'Invite', hash, 'lsc_inv', now, now + 7 * DAY_MS)
        .run();
    await insertInvite('invite-1', 'sha256-of-token-a');
    await expect(insertInvite('invite-2', 'sha256-of-token-a')).rejects.toThrow(
      /UNIQUE constraint failed/u,
    );

    // Redeeming an invite points at the user; deleting the user keeps the
    // redemption row and clears the reference (ON DELETE SET NULL).
    await db.exec('PRAGMA foreign_keys = ON;');
    await db
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-invite', 'Redeemed', 'redeemed@example.test', 1, ?, ?)",
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        'UPDATE staff_invites SET used_at = ?, used_by_user_id = ? WHERE id = ?',
      )
      .bind(now + DAY_MS, 'user-invite', 'invite-1')
      .run();
    await db.prepare("DELETE FROM user WHERE id = 'user-invite'").run();
    const survived = await singleRow(
      db,
      'SELECT * FROM staff_invites WHERE id = ?',
      'invite-1',
    );
    expect(survived.used_by_user_id).toBeNull();
    expect(survived.used_at).toBe(now + DAY_MS);

    const insertClaim = (
      id: string,
      key: string,
      kind: string,
      reference: string,
    ) =>
      db
        .prepare(
          'INSERT INTO registration_claims (id, claim_key, grant_kind, grant_ref, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(id, key, kind, reference, now)
        .run();

    // A live bootstrap row allows a bootstrap claim.
    await insertClaim('claim-1', 'key-1', 'bootstrap', 'default');

    // Consuming the bootstrap state rejects further bootstrap grants.
    await db
      .prepare(
        "UPDATE bootstrap_state SET consumed_at = ? WHERE id = 'default'",
      )
      .bind(now)
      .run();
    await expect(
      insertClaim('claim-2', 'key-2', 'bootstrap', 'default'),
    ).rejects.toThrow(/registration grant unavailable/u);

    // Invite grants require a live matching staff invite.
    await expect(
      insertClaim('claim-3', 'key-3', 'invite', 'missing-hash'),
    ).rejects.toThrow(/registration grant unavailable/u);
    await db
      .prepare(
        'INSERT INTO staff_invites (id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('invite-3', 'Live', 'grant-hash', 'lsc_inv', now, now + 7 * DAY_MS)
      .run();
    await insertClaim('claim-4', 'key-4', 'invite', 'grant-hash');

    // A revoked invite no longer grants.
    await db
      .prepare("UPDATE staff_invites SET revoked_at = ? WHERE id = 'invite-3'")
      .bind(now)
      .run();
    await expect(
      insertClaim('claim-5', 'key-5', 'invite', 'grant-hash'),
    ).rejects.toThrow(/registration grant unavailable/u);
  } finally {
    await dispose();
  }
});
