/**
 * Atomic registration redemption primitive (stage s2).
 *
 * `redeemRegistration` consumes exactly one eligible grant — the one-time
 * bootstrap grant or a staff invite token — and, in a single D1 batch,
 * writes the Better Auth user row, the credential account row, and the
 * durable claim ledger row, then marks the grant consumed.
 *
 * Atomicity strategy (per the stage contract; no mutexes, no
 * check-then-write, no compensating deletes, no adapter transaction):
 *
 * - One `db.batch([...])` is the only commit boundary. D1 batches are
 *   all-or-nothing: any statement failure rolls back every statement.
 * - The `registration_claims.claim_key` UNIQUE index is the durable race
 *   guard. Two concurrent redemptions of the same grant cannot both
 *   insert a claim, so the loser's whole batch — including its user and
 *   account writes — rolls back.
 * - The `registration_claims_grant_guard` trigger (migration 0005)
 *   re-validates grant eligibility at claim-insert time, inside the
 *   batch. A grant that is revoked, used, or expires between the
 *   pre-check below and the batch therefore still fails atomically.
 *   `RAISE(ABORT)` aborts the entire batch.
 * - The claim row references the user with ON DELETE SET NULL, so the
 *   durable claim survives account deletion. Deleting the bootstrap user
 *   never reopens the bootstrap grant.
 *
 * The pre-checks below exist only to classify failures into the stable
 * error codes the HTTP layer will later need. They are not the guard:
 * every one of them is re-enforced durably by the batch itself.
 *
 * Error contract:
 * - ineligible or unavailable grant (missing, revoked, used, expired,
 *   bootstrap already consumed, or lost the redemption race) resolves
 *   with `RegistrationError { code: 'invite_unavailable' }`;
 * - an existing user with the same email resolves with
 *   `RegistrationError { code: 'email_exists' }`;
 * - any other persistence fault (including a failing account write)
 *   rejects — it never resolves with partial state, because the batch
 *   rolls back.
 */

export type RedeemRegistrationInput = {
  /**
   * Caller-generated credential account row primary key.
   */
  accountId: string;
  email: string;
  grant: RegistrationGrant;
  name: string;
  /**
   * Unix milliseconds used for every timestamp and expiry comparison.
   */
  now: number;
  passwordHash: string;
  /**
   * Caller-generated user id (Better Auth user row primary key).
   */
  userId: string;
};

export type RedeemRegistrationResult = { userId: string };

export type RegistrationErrorCode =
  'email_exists' | 'invite_unavailable' | 'persistence_fault';

/**
 * The grant being redeemed: the bootstrap grant or a staff invite.
 */
export type RegistrationGrant =
  { kind: 'bootstrap' } | { kind: 'invite'; tokenHash: string };

export class RegistrationError extends Error {
  readonly code: RegistrationErrorCode;

  constructor(code: RegistrationErrorCode, message: string) {
    super(message);
    this.name = 'RegistrationError';
    this.code = code;
  }
}

const BOOTSTRAP_CLAIM_KEY = 'bootstrap';
// bootstrap_state is a singleton table; migration 0004 fixes the row id
// to 'default' (CHECK constraint), while the claim ledger keys the
// bootstrap grant under claim_key 'bootstrap'.
const BOOTSTRAP_STATE_ID = 'default';

const emailExistsError = new RegistrationError(
  'email_exists',
  'an account with this email already exists',
);

const grantUnavailableError = new RegistrationError(
  'invite_unavailable',
  'the registration grant is unavailable',
);

const loadBootstrap = async (
  database: D1Database,
): Promise<{ consumedAt: null | number; expiresAt: number }> => {
  const row = await database
    .prepare('SELECT consumed_at, expires_at FROM bootstrap_state WHERE id = ?')
    .bind(BOOTSTRAP_STATE_ID)
    .first<{ consumed_at: null | number; expires_at: number }>();
  if (row === null) {
    throw grantUnavailableError;
  }

  return { consumedAt: row.consumed_at, expiresAt: row.expires_at };
};

const loadInvite = async (
  database: D1Database,
  tokenHash: string,
): Promise<{
  expiresAt: number;
  revokedAt: null | number;
  usedAt: null | number;
}> => {
  const row = await database
    .prepare(
      'SELECT used_at, revoked_at, expires_at FROM staff_invites WHERE token_hash = ?',
    )
    .bind(tokenHash)
    .first<{
      expires_at: number;
      revoked_at: null | number;
      used_at: null | number;
    }>();
  if (row === null) {
    throw grantUnavailableError;
  }

  return {
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    usedAt: row.used_at,
  };
};

/**
 * Maps a failed redemption batch onto the error contract. The pre-checks
 * already classify the common cases; the batch can still fail when the
 * state changed in the window between the pre-check and the commit.
 */
const rejectWithContractError = (error: unknown): never => {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (message.includes('user_email_unique') || message.includes('user.email')) {
    throw emailExistsError;
  }

  if (
    message.includes('registration grant unavailable') ||
    message.includes('registration_claims_claim_key_unique') ||
    message.includes('registration_claims.claim_key')
  ) {
    throw grantUnavailableError;
  }

  const fault = new RegistrationError(
    'persistence_fault',
    'registration could not be completed and was rolled back',
  );
  fault.cause = error;
  throw fault;
};

/**
 * Redeems a grant and atomically creates the account it authorizes.
 *
 * On success the batch has committed: user row, credential account row
 * (Better Auth convention: account_id equals the user id), the durable
 * claim row, and the grant consumption mark. On any failure nothing is
 * written. See the module header for the atomicity strategy and the
 * error contract.
 */
export const redeemRegistration = async (
  database: D1Database,
  input: RedeemRegistrationInput,
): Promise<RedeemRegistrationResult> => {
  const { accountId, email, grant, name, now, passwordHash, userId } = input;

  // Classification pre-checks (not the guard; the batch re-enforces all of
  // this durably). Unix milliseconds compare chronologically, and a grant
  // whose expires_at equals now is already expired (strict `>`).
  if (grant.kind === 'bootstrap') {
    const state = await loadBootstrap(database);
    if (state.consumedAt !== null || state.expiresAt <= now) {
      throw grantUnavailableError;
    }
  } else {
    const invite = await loadInvite(database, grant.tokenHash);
    if (
      invite.usedAt !== null ||
      invite.revokedAt !== null ||
      invite.expiresAt <= now
    ) {
      throw grantUnavailableError;
    }
  }

  const existingUser = await database
    .prepare('SELECT id FROM user WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (existingUser !== null) {
    throw emailExistsError;
  }

  // User, account, and every app-owned timestamp store Unix milliseconds.
  const timestamp = now;
  const claimKey =
    grant.kind === 'bootstrap' ? BOOTSTRAP_CLAIM_KEY : grant.tokenHash;

  // Statement order matters for classification: the user insert runs
  // first so a duplicate email is reported as email_exists even when the
  // grant is simultaneously being consumed by another request. The claim
  // insert runs before the consumption mark so the durable guard
  // (trigger + unique claim_key) validates the grant inside this batch.
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        'INSERT INTO user (id, name, email, email_verified, created_at, updated_at) ' +
          'VALUES (?, ?, ?, 0, ?, ?)',
      )
      .bind(userId, name, email, timestamp, timestamp),
    database
      .prepare(
        'INSERT INTO account (id, account_id, provider_id, user_id, password, ' +
          'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        accountId,
        userId,
        'credential',
        userId,
        passwordHash,
        timestamp,
        timestamp,
      ),
    database
      .prepare(
        'INSERT INTO registration_claims (id, grant_kind, grant_ref, claim_key, ' +
          'user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(crypto.randomUUID(), grant.kind, claimKey, claimKey, userId, now),
  ];
  if (grant.kind === 'bootstrap') {
    statements.push(
      database
        .prepare(
          'UPDATE bootstrap_state SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
        )
        .bind(now, BOOTSTRAP_STATE_ID),
    );
  } else {
    statements.push(
      database
        .prepare(
          'UPDATE staff_invites SET used_at = ?, used_by_user_id = ? ' +
            'WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
        )
        .bind(now, userId, claimKey, now),
    );
  }

  try {
    await database.batch(statements);
  } catch (error) {
    rejectWithContractError(error);
  }

  return { userId };
};
