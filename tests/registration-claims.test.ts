import {
  redeemRegistration,
  type RegistrationGrant,
} from '@/auth/registration-repository';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Migration 0005 (atomic_registration_claims) and the durable guard
 * coverage, applied against real Miniflare D1 — the same migration files
 * the worker fixture applies.
 *
 * - a fresh DB that applies every migration (0000..0005), to verify the
 *   claim ledger table, its UNIQUE claim_key race guard, and the grant
 *   guard trigger (including that a claim row survives user deletion via
 *   ON DELETE SET NULL);
 * - end-to-end redemptions through `redeemRegistration` to verify the
 *   error contract and the two-request race.
 */

const repoRoot = process.cwd();
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-08-14T00:00:00.000Z');

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
  const result = await database
    .prepare(sql)
    .bind(...binds)
    .all<Row>();
  return result.results;
};

const singleRow = async (
  database: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<Row> => {
  const row = await database
    .prepare(sql)
    .bind(...binds)
    .first<Row>();
  if (row === null) {
    throw new Error(`no row for: ${sql}`);
  }

  return row;
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

const freshDatabase = async (): Promise<{
  db: D1Database;
  dispose: () => Promise<void>;
}> => {
  const fixture = await startD1();
  for (const name of await listMigrations()) {
    await applyFile(fixture.db, name);
  }

  return fixture;
};

const insertInvite = (
  database: D1Database,
  tokenHash: string,
  expiresAt: number,
): Promise<D1Result> =>
  database
    .prepare(
      'INSERT INTO staff_invites (id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      `invite-${tokenHash}`,
      'Fixture',
      tokenHash,
      tokenHash.slice(0, 4),
      Date.parse('2026-08-01T00:00:00.000Z'),
      expiresAt,
    )
    .run();

const redeemInput = (grant: RegistrationGrant, suffix: string) => ({
  accountId: `account-${suffix}`,
  email: `${suffix}@example.test`,
  grant,
  name: 'Fixture User',
  now: NOW,
  passwordHash: 'fixture-password-hash',
  userId: `user-${suffix}`,
});

test('fresh database: claim ledger table, unique claim_key, guard trigger', async () => {
  const { db, dispose } = await freshDatabase();
  try {
    const columns = (
      await allRows(db, 'PRAGMA table_info(registration_claims)')
    ).map((column) => String(column.name));
    expect(columns).toEqual([
      'claim_key',
      'created_at',
      'grant_kind',
      'grant_ref',
      'id',
      'user_id',
    ]);
    const indexes = (
      await allRows(db, 'PRAGMA index_list(registration_claims)')
    ).map((index) => String(index.name));
    expect(indexes).toContain('registration_claims_claim_key_unique');
    const trigger = await db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'registration_claims_grant_guard'",
      )
      .first<{ sql: string }>();
    expect(
      trigger !== null && trigger.sql.includes('RAISE(ABORT'),
      'guard trigger exists',
    ).toBe(true);

    // The durable guard rejects a claim for an ineligible grant on its own:
    // the bootstrap grant is unconsumed, so an invite claim for a nonexistent
    // token hash must be aborted inside the statement.
    await expect(
      db
        .prepare(
          'INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind('c-ghost', 'invite', 'ghost-hash', 'ghost-hash', 'u-ghost', NOW)
        .run(),
    ).rejects.toThrow('registration grant unavailable');

    // And the same claim_key cannot be inserted twice (the race guard).
    await db
      .prepare(
        'INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('c-b1', 'bootstrap', 'bootstrap', 'bootstrap', null, NOW)
      .run();
    await expect(
      db
        .prepare(
          'INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind('c-b2', 'bootstrap', 'bootstrap', 'bootstrap', null, NOW)
        .run(),
    ).rejects.toThrow('UNIQUE constraint failed');

    // A durable claim survives user deletion: the claim row keeps its
    // grant closed even after the account is deleted (ON DELETE SET NULL).
    // A fresh invite grant is used because the bootstrap claim_key is
    // already taken by c-b1.
    await db
      .prepare(
        "INSERT INTO user (id, name, email) VALUES ('u-1', 'A', 'u1@test')",
      )
      .run();
    await insertInvite(db, 'hash-del', Date.parse('2999-01-01T00:00:00.000Z'));
    await db
      .prepare(
        'INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('c-b3', 'invite', 'hash-del', 'hash-del', 'u-1', NOW)
      .run();
    await db.prepare("DELETE FROM user WHERE id = 'u-1'").run();
    const claim = await singleRow(
      db,
      "SELECT user_id FROM registration_claims WHERE id = 'c-b3'",
    );
    expect(claim.user_id).toBeNull();
  } finally {
    await dispose();
  }
});

test('bootstrap redemption: atomic commit, permanent closure, deletion survives', async () => {
  const { db, dispose } = await freshDatabase();
  try {
    const result = await redeemRegistration(
      db,
      redeemInput({ kind: 'bootstrap' }, 'boot'),
    );
    expect(result).toEqual({ userId: 'user-boot' });
    expect(
      await allRows(db, 'SELECT id, email FROM user WHERE id = ?', 'user-boot'),
    ).toHaveLength(1);
    const account = await singleRow(
      db,
      'SELECT account_id, provider_id, user_id FROM account WHERE id = ?',
      'account-boot',
    );
    expect(account).toEqual({
      account_id: 'user-boot',
      provider_id: 'credential',
      user_id: 'user-boot',
    });
    const claim = await singleRow(
      db,
      "SELECT grant_kind, grant_ref, claim_key, user_id FROM registration_claims WHERE claim_key = 'bootstrap'",
    );
    expect(claim).toEqual({
      claim_key: 'bootstrap',
      grant_kind: 'bootstrap',
      grant_ref: 'bootstrap',
      user_id: 'user-boot',
    });
    expect(
      (
        await singleRow(
          db,
          "SELECT consumed_at FROM bootstrap_state WHERE id = 'default'",
        )
      ).consumed_at,
    ).toBe(NOW);

    // The grant is permanently consumed: re-redemption fails with the
    // contract code and leaves no new user/account/claim rows.
    await expect(
      redeemRegistration(db, redeemInput({ kind: 'bootstrap' }, 'boot-2')),
    ).rejects.toMatchObject({ code: 'invite_unavailable' });
    expect(await allRows(db, 'SELECT id FROM user')).toHaveLength(1);
    expect(await allRows(db, 'SELECT id FROM account')).toHaveLength(1);
    expect(
      await allRows(db, 'SELECT id FROM registration_claims'),
    ).toHaveLength(1);

    // Deleting the account does not reopen the bootstrap grant.
    await db.prepare("DELETE FROM user WHERE id = 'user-boot'").run();
    const surviving = await singleRow(
      db,
      "SELECT user_id FROM registration_claims WHERE claim_key = 'bootstrap'",
    );
    expect(surviving.user_id).toBeNull();
    await expect(
      redeemRegistration(db, redeemInput({ kind: 'bootstrap' }, 'boot-3')),
    ).rejects.toMatchObject({ code: 'invite_unavailable' });
    expect(await allRows(db, 'SELECT id FROM user')).toHaveLength(0);
  } finally {
    await dispose();
  }
});

test('invite redemption: single use, revocation, expiry, duplicate email, race', async () => {
  const { db, dispose } = await freshDatabase();
  try {
    // Single use: the invite is consumed exactly once.
    await insertInvite(db, 'hash-one', NOW + 7 * DAY_MS);
    const first = await redeemRegistration(
      db,
      redeemInput({ kind: 'invite', tokenHash: 'hash-one' }, 'inv-1'),
    );
    expect(first).toEqual({ userId: 'user-inv-1' });
    const consumed = await singleRow(
      db,
      'SELECT used_at, used_by_user_id FROM staff_invites WHERE token_hash = ?',
      'hash-one',
    );
    expect(consumed).toEqual({ used_at: NOW, used_by_user_id: 'user-inv-1' });
    await expect(
      redeemRegistration(
        db,
        redeemInput({ kind: 'invite', tokenHash: 'hash-one' }, 'inv-2'),
      ),
    ).rejects.toMatchObject({ code: 'invite_unavailable' });
    expect(await allRows(db, 'SELECT id FROM user')).toHaveLength(1);

    // Revoked and expired invites are unavailable.
    await insertInvite(db, 'hash-two', NOW + 7 * DAY_MS);
    await db
      .prepare('UPDATE staff_invites SET revoked_at = ? WHERE token_hash = ?')
      .bind(NOW, 'hash-two')
      .run();
    await insertInvite(db, 'hash-old', NOW - DAY_MS);
    await insertInvite(db, 'hash-eq', NOW);
    for (const tokenHash of ['hash-two', 'hash-old', 'hash-eq']) {
      await expect(
        redeemRegistration(
          db,
          redeemInput({ kind: 'invite', tokenHash }, `x-${tokenHash}`),
        ),
      ).rejects.toMatchObject({ code: 'invite_unavailable' });
    }

    expect(await allRows(db, 'SELECT id FROM user')).toHaveLength(1);

    // Duplicate email: rejected with email_exists, the invite stays usable.
    await insertInvite(db, 'hash-three', NOW + 7 * DAY_MS);
    await db
      .prepare('INSERT INTO user (id, name, email) VALUES (?, ?, ?)')
      .bind('user-taken', 'Taken', 'taken@example.test')
      .run();
    await expect(
      redeemRegistration(db, {
        ...redeemInput({ kind: 'invite', tokenHash: 'hash-three' }, 'taken'),
        email: 'taken@example.test',
      }),
    ).rejects.toMatchObject({ code: 'email_exists' });
    const untouched = await singleRow(
      db,
      'SELECT used_at FROM staff_invites WHERE token_hash = ?',
      'hash-three',
    );
    expect(untouched.used_at).toBeNull();
    expect(
      await allRows(
        db,
        'SELECT id FROM registration_claims WHERE grant_ref = ?',
        'hash-three',
      ),
    ).toHaveLength(0);

    // Two-request race on the same invite: exactly one redemption commits,
    // and the loser rolls back its user/account/claim writes in full.
    await insertInvite(db, 'hash-race', NOW + 7 * DAY_MS);
    const outcomes = await Promise.allSettled(
      [0, 1].map((index) =>
        redeemRegistration(
          db,
          redeemInput(
            { kind: 'invite', tokenHash: 'hash-race' },
            `race-${index}`,
          ),
        ),
      ),
    );
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    expect(fulfilled).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toBeDefined();
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toMatchObject({ code: 'invite_unavailable' });
    }

    expect(
      await allRows(db, "SELECT id FROM user WHERE id LIKE 'user-race-%'"),
    ).toHaveLength(1);
    expect(
      await allRows(
        db,
        "SELECT id FROM account WHERE id LIKE 'account-race-%'",
      ),
    ).toHaveLength(1);
    expect(
      await allRows(
        db,
        "SELECT id FROM registration_claims WHERE grant_ref = 'hash-race'",
      ),
    ).toHaveLength(1);
  } finally {
    await dispose();
  }
});

test('bootstrap race: exactly one winner, no partial state', async () => {
  const { db, dispose } = await freshDatabase();
  try {
    const outcomes = await Promise.allSettled(
      [0, 1].map((index) =>
        redeemRegistration(
          db,
          redeemInput({ kind: 'bootstrap' }, `rb-${index}`),
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect(await allRows(db, 'SELECT id FROM user')).toHaveLength(1);
    expect(await allRows(db, 'SELECT id FROM account')).toHaveLength(1);
    expect(
      await allRows(db, 'SELECT id FROM registration_claims'),
    ).toHaveLength(1);
  } finally {
    await dispose();
  }
});
