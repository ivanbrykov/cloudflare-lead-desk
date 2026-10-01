import {
  activities,
  apiTokens,
  bootstrapState,
  idempotencyKeys,
  leads,
  session,
  staffInvites,
  user,
} from './schema';
import { type RegistrationGrant } from '@/auth/registration-repository';
import { type IntakeResponse } from '@/domain/intake';
import { encodeKeysetCursor, type Keyset } from '@/domain/pagination';
import {
  type CreateLeadInput,
  type IntakeInput,
  normalizeEmail,
  type SkippedField,
  type UpdateLeadInput,
} from '@/domain/schemas';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

export type Env = {
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  // Optional canonical origin override. When absent or blank, authentication
  // uses the incoming request URL's origin; production requires HTTPS.
  BETTER_AUTH_URL?: string;
  DB: D1Database;
  // Development/test-only identity bypass. Never honored in production.
  DEV_ADMIN_EMAIL?: string;
  ENVIRONMENT: 'development' | 'production' | 'test';
  // Invite token required to create a staff account (X-Setup-Token header on
  // POST /api/auth/sign-up/email). Unset or empty rejects every sign-up.
  SETUP_TOKEN?: string;
};

export const DEFAULT_WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const now = (): Date => new Date();
const id = (): string => {
  let timestamp = Date.now();
  let result = '';
  for (let index = 0; index < 10; index += 1) {
    result = ULID_ALPHABET[timestamp % 32] + result;
    timestamp = Math.floor(timestamp / 32);
  }

  const random = crypto.getRandomValues(new Uint8Array(16));
  return (
    result + Array.from(random, (value) => ULID_ALPHABET[value % 32]).join('')
  );
};

const getDatabase = (environment: Env) => drizzle(environment.DB);

export type LeadPage = {
  leads: LeadRecord[];
  nextCursor: null | string;
};

export type LeadPageOptions = {
  cursor?: Keyset | null;
  limit: number;
  query?: string;
};

export type LeadRecord = {
  createdAt: Date;
  customFields: Record<string, unknown>;
  deletedAt: Date | null;
  duplicateCount: number;
  email: null | string;
  estimatedValue: null | number;
  firstName: null | string;
  id: string;
  lastName: null | string;
  origin: null | string;
  rawPayload?: null | Record<string, unknown>;
  skippedFields: null | SkippedField[];
  source: string;
  tokenId: null | string;
  tokenName?: null | string;
  tokenType?: 'api' | 'browser' | null;
  updatedAt: Date;
};

/**
 * Literal, case-insensitive substring match on the email or first/last name.
 * `instr` is used instead of LIKE because D1 caps LIKE/GLOB patterns at 50
 * bytes — an ordinary search string exceeds that once wrapped — and because
 * it removes wildcard escaping entirely, so a literal backslash, `%`, or `_`
 * matches itself.
 */
const leadSearchPredicate = (query: string) => {
  const needle = sql`lower(${query})`;
  return sql`(instr(lower(${leads.email}), ${needle}) > 0 OR instr(lower(${leads.firstName}), ${needle}) > 0 OR instr(lower(${leads.lastName}), ${needle}) > 0)`;
};

/**
 * Count of live leads that share the row's normalized email, including the row
 * itself. Computed in the page/detail query with the leads_email_idx index, so
 * list responses need no second round trip and bind no variable-length email
 * list (D1 caps bound parameters per statement). The outer columns are
 * qualified by hand because Drizzle renders a single-table FROM without a table
 * prefix in a select projection. `toLead` subtracts the row itself to produce
 * the duplicate hint.
 */
const duplicateCountExpression = sql<number>`(
  SELECT count(*) FROM leads AS duplicate
  WHERE duplicate.workspace_id = leads.workspace_id
    AND duplicate.deleted_at IS NULL
    AND duplicate.email IS NOT NULL
    AND duplicate.email = leads.email
)`;

type LeadListRow = Omit<
  typeof leads.$inferSelect,
  'rawPayload' | 'workspaceId'
>;

const toLead = (
  row: LeadListRow & { duplicateCount: number },
  detail: {
    rawPayload?: null | Record<string, unknown>;
    tokenName?: null | string;
    tokenType?: 'api' | 'browser' | null;
  } = {},
): LeadRecord => ({
  createdAt: row.createdAt,
  customFields: row.customFields,
  deletedAt: row.deletedAt,
  duplicateCount: row.email ? Math.max(0, Number(row.duplicateCount) - 1) : 0,
  email: row.email,
  estimatedValue: row.estimatedValue,
  firstName: row.firstName,
  id: row.id,
  lastName: row.lastName,
  origin: row.origin,
  skippedFields: row.skippedFields ?? null,
  source: row.source,
  tokenId: row.tokenId,
  updatedAt: row.updatedAt,
  ...(detail.rawPayload === undefined ? {} : { rawPayload: detail.rawPayload }),
  ...(detail.tokenName === undefined ? {} : { tokenName: detail.tokenName }),
  ...(detail.tokenType === undefined ? {} : { tokenType: detail.tokenType }),
});

/**
 * Keyset (seek) pagination over (created_at DESC, id DESC), excluding
 * soft-deleted leads. One extra row detects a following page without a COUNT.
 */
export const listLeads = async (
  environment: Env,
  options: LeadPageOptions,
): Promise<LeadPage> => {
  const { cursor, limit, query } = options;
  const predicates = [
    eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
    isNull(leads.deletedAt),
  ];
  if (query) {
    predicates.push(leadSearchPredicate(query));
  }

  if (cursor) {
    const cursorTime = Date.parse(cursor.createdAt);
    predicates.push(
      sql`(${leads.createdAt} < ${cursorTime} OR (${leads.createdAt} = ${cursorTime} AND ${leads.id} < ${cursor.id}))`,
    );
  }

  const rows = await getDatabase(environment)
    .select({
      createdAt: leads.createdAt,
      customFields: leads.customFields,
      deletedAt: leads.deletedAt,
      duplicateCount: duplicateCountExpression,
      email: leads.email,
      estimatedValue: leads.estimatedValue,
      firstName: leads.firstName,
      id: leads.id,
      lastName: leads.lastName,
      origin: leads.origin,
      skippedFields: leads.skippedFields,
      source: leads.source,
      tokenId: leads.tokenId,
      updatedAt: leads.updatedAt,
    })
    .from(leads)
    .where(and(...predicates))
    .orderBy(desc(leads.createdAt), desc(leads.id))
    .limit(limit + 1);
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    leads: pageRows.map((row) => toLead(row)),
    nextCursor:
      hasNextPage && last
        ? encodeKeysetCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
  };
};

export const getLead = async (
  environment: Env,
  leadId: string,
): Promise<LeadRecord | null> => {
  const row = await getDatabase(environment)
    .select({
      ...getTableColumns(leads),
      duplicateCount: duplicateCountExpression,
    })
    .from(leads)
    .where(
      and(eq(leads.workspaceId, DEFAULT_WORKSPACE_ID), eq(leads.id, leadId)),
    )
    .get();
  if (!row) {
    return null;
  }

  const token = row.tokenId
    ? await getDatabase(environment)
        .select({ name: apiTokens.name, type: apiTokens.type })
        .from(apiTokens)
        .where(eq(apiTokens.id, row.tokenId))
        .get()
    : undefined;
  return toLead(row, {
    rawPayload: row.rawPayload,
    tokenName: token?.name ?? null,
    tokenType: token?.type ?? null,
  });
};

export const listLeadActivities = async (environment: Env, leadId: string) =>
  getDatabase(environment)
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(activities.leadId, leadId),
      ),
    )
    .orderBy(desc(activities.createdAt));

const randomToken = (prefix: string): string =>
  `${prefix}${crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '')}`;

const hashToken = async (token: string): Promise<string> => {
  const source = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(hash))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
};

const TOKEN_DEFAULT_TTL_MS = 90 * 86_400_000;

export const createApiToken = async (
  environment: Env,
  input: { expiresAt?: null | string; name: string; type: 'api' | 'browser' },
) => {
  const raw = randomToken(input.type === 'browser' ? 'lsc_pub_' : 'lsc_');
  const record = {
    createdAt: now(),
    expiresAt:
      input.expiresAt === undefined
        ? new Date(Date.now() + TOKEN_DEFAULT_TTL_MS)
        : input.expiresAt === null
          ? null
          : new Date(input.expiresAt),
    id: id(),
    name: input.name,
    prefix: raw.slice(0, 12),
    scope: 'intake:write',
    token: input.type === 'browser' ? raw : null,
    tokenHash: input.type === 'api' ? await hashToken(raw) : null,
    type: input.type,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(apiTokens).values(record);
  // API tokens are shown exactly once; browser tokens are stored so they can
  // be copied into a site again. The hash never leaves the server.
  return {
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    revokedAt: null,
    scope: record.scope,
    token: raw,
    type: record.type,
  };
};

export const listApiTokens = async (environment: Env) =>
  getDatabase(environment)
    .select({
      createdAt: apiTokens.createdAt,
      expiresAt: apiTokens.expiresAt,
      id: apiTokens.id,
      lastUsedAt: apiTokens.lastUsedAt,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      revokedAt: apiTokens.revokedAt,
      scope: apiTokens.scope,
      token: apiTokens.token,
      type: apiTokens.type,
    })
    .from(apiTokens)
    .where(eq(apiTokens.workspaceId, DEFAULT_WORKSPACE_ID))
    .orderBy(desc(apiTokens.createdAt));

export const revokeApiToken = async (environment: Env, tokenId: string) => {
  const result = await getDatabase(environment)
    .update(apiTokens)
    .set({ revokedAt: now() })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .run();
  return result.meta.changes > 0;
};

// --- Single-use staff invitations ----------------------------------------
//
// The raw token exists only in the create response; persistence is the
// SHA-256 hash only. The validate endpoint never consumes an invitation;
// redemption happens at registration.

const INVITE_DEFAULT_TTL_MS = 7 * 86_400_000;

export type InviteRecord = {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  name: string;
  prefix: string;
  revokedAt: Date | null;
  usedAt: Date | null;
};

export const createStaffInvite = async (
  environment: Env,
  name: string,
  expiresAt?: string,
): Promise<InviteRecord & { token: string }> => {
  const raw = `lsc_${crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '')}`;
  const tokenHash = await hashToken(raw);
  const record: InviteRecord = {
    createdAt: now(),
    expiresAt:
      expiresAt === undefined
        ? new Date(Date.now() + INVITE_DEFAULT_TTL_MS)
        : new Date(expiresAt),
    id: id(),
    name,
    prefix: raw.slice(0, 12),
    revokedAt: null,
    usedAt: null,
  };
  await getDatabase(environment)
    .insert(staffInvites)
    .values({
      ...record,
      tokenHash,
    });
  return { ...record, token: raw };
};

export const listStaffInvites = async (environment: Env) =>
  getDatabase(environment)
    .select({
      createdAt: staffInvites.createdAt,
      expiresAt: staffInvites.expiresAt,
      id: staffInvites.id,
      name: staffInvites.name,
      prefix: staffInvites.prefix,
      revokedAt: staffInvites.revokedAt,
      usedAt: staffInvites.usedAt,
    })
    .from(staffInvites)
    .orderBy(desc(staffInvites.createdAt));

export const revokeStaffInvite = async (
  environment: Env,
  inviteId: string,
): Promise<boolean> => {
  const result = await getDatabase(environment)
    .update(staffInvites)
    .set({ revokedAt: now() })
    .where(eq(staffInvites.id, inviteId))
    .run();
  return result.meta.changes > 0;
};

/**
 * Resolves a presented raw invite token to an available staff-invite
 * grant. Returns undefined when the token does not match an unrevoked,
 * unused, unexpired invite.
 */
export const availableStaffInviteGrant = async (
  environment: Env,
  token: string,
): Promise<RegistrationGrant | undefined> => {
  if (token === '') {
    return undefined;
  }

  const tokenHash = await hashToken(token);
  const record = await getDatabase(environment)
    .select()
    .from(staffInvites)
    .where(eq(staffInvites.tokenHash, tokenHash))
    .get();
  if (
    record === undefined ||
    record.revokedAt !== null ||
    record.usedAt !== null ||
    record.expiresAt.getTime() <= now().getTime()
  ) {
    return undefined;
  }

  return { kind: 'invite', tokenHash };
};

/**
 * Non-consuming invitation check: available only while unrevoked, unused,
 * and unexpired.
 */
export const checkStaffInviteAvailability = async (
  environment: Env,
  token: string,
): Promise<boolean> =>
  (await availableStaffInviteGrant(environment, token)) !== undefined;

/**
 * Bootstrap grant availability: the seeded singleton must be unconsumed and
 * unexpired, and no account may exist yet (the current-account rule of
 * registration redemption).
 */
export const isBootstrapGrantAvailable = async (
  environment: Env,
): Promise<boolean> => {
  const database = getDatabase(environment);
  const [bootstrap, account] = await Promise.all([
    database
      .select({
        consumedAt: bootstrapState.consumedAt,
        expiresAt: bootstrapState.expiresAt,
      })
      .from(bootstrapState)
      .where(eq(bootstrapState.id, 'default'))
      .get(),
    database.select({ id: user.id }).from(user).limit(1).get(),
  ]);
  return (
    bootstrap !== undefined &&
    bootstrap.consumedAt === null &&
    account === undefined &&
    bootstrap.expiresAt.getTime() > now().getTime()
  );
};

export type StaffAccountRecord = {
  disabledAt: Date | null;
  email: string;
  id: string;
  name: string;
};

const staffAccountColumns = {
  disabledAt: user.disabledAt,
  email: user.email,
  id: user.id,
  name: user.name,
} as const;

/**
 * Lists every staff account (every account is staff) with the public
 * projection: id, name, email, and the durable disabled state.
 */
export const listStaffAccounts = async (
  environment: Env,
): Promise<StaffAccountRecord[]> =>
  getDatabase(environment)
    .select(staffAccountColumns)
    .from(user)
    .orderBy(asc(user.email), asc(user.id));

/**
 * Resolves a normalized (lowercase) email to its staff-account record.
 */
export const getStaffAccountByEmail = async (
  environment: Env,
  email: string,
): Promise<StaffAccountRecord | undefined> =>
  getDatabase(environment)
    .select(staffAccountColumns)
    .from(user)
    .where(eq(user.email, email))
    .get();

export type SetStaffDisabledOutcome =
  | { kind: 'last-enabled' }
  | { kind: 'not-found' }
  | { kind: 'self' }
  | { kind: 'updated'; record: StaffAccountRecord };

/**
 * Durable staff revocation (stage s5). Disabling writes the flag and
 * deletes every session of the account in ONE D1 batch (single
 * transaction): a disabled account can never hold a live session. The
 * session DELETE is scoped to rows whose owner is disabled after the
 * UPDATE, so a concurrently no-op update can never revoke a
 * still-enabled account's sessions. Re-enabling clears the flag only:
 * deleted session rows are never restored, so the account keeps its
 * credentials but must sign in again.
 *
 * `actorEmail` identifies the signed-in admin performing the change and
 * enforces the self-disable protection; the enabled-count guard enforces
 * the last-enabled-account protection atomically with the UPDATE.
 */
export const setStaffAccountDisabled = async (
  environment: Env,
  userId: string,
  disabled: boolean,
  actorEmail: string,
): Promise<SetStaffDisabledOutcome> => {
  const database = getDatabase(environment);
  const target = await database
    .select(staffAccountColumns)
    .from(user)
    .where(eq(user.id, userId))
    .get();
  if (target === undefined) {
    return { kind: 'not-found' };
  }

  const isDisabled = target.disabledAt !== null;
  if (disabled === isDisabled) {
    // Idempotent: the requested state already holds.
    return { kind: 'updated', record: target };
  }

  if (disabled) {
    if (target.email === actorEmail.toLowerCase()) {
      return { kind: 'self' };
    }

    const enabled = await database
      .select({ count: sql<number>`count(*)` })
      .from(user)
      .where(isNull(user.disabledAt))
      .get();
    if (Number(enabled?.count ?? 0) <= 1) {
      return { kind: 'last-enabled' };
    }

    const timestamp = new Date();
    const [result] = await database.batch([
      database
        .update(user)
        .set({ disabledAt: timestamp, updatedAt: timestamp })
        .where(
          and(
            eq(user.id, userId),
            isNull(user.disabledAt),
            sql`(select count(*) from user where disabled_at is null) >= 2`,
          ),
        ),
      database
        .delete(session)
        .where(
          and(
            eq(session.userId, userId),
            sql`(select disabled_at from user where id = ${userId}) is not null`,
          ),
        ),
    ]);
    if (result.meta.changes === 0) {
      // Lost a concurrent race; re-derive the outcome from the committed
      // state instead of guessing.
      const current = await database
        .select(staffAccountColumns)
        .from(user)
        .where(eq(user.id, userId))
        .get();
      if (current === undefined) {
        return { kind: 'not-found' };
      }

      if (current.disabledAt === null) {
        return { kind: 'last-enabled' };
      }

      return { kind: 'updated', record: current };
    }

    return { kind: 'updated', record: { ...target, disabledAt: timestamp } };
  }

  const [updated] = await database.batch([
    database
      .update(user)
      .set({ disabledAt: null, updatedAt: new Date() })
      .where(and(eq(user.id, userId), isNotNull(user.disabledAt))),
  ]);
  if (updated.meta.changes === 0) {
    // A concurrent enable already cleared the flag; re-read the committed
    // state.
    const current = await database
      .select(staffAccountColumns)
      .from(user)
      .where(eq(user.id, userId))
      .get();
    if (current === undefined) {
      return { kind: 'not-found' };
    }

    return { kind: 'updated', record: current };
  }

  return { kind: 'updated', record: { ...target, disabledAt: null } };
};

/**
 * Intake authorization gate. A token is usable only while unrevoked,
 * scoped to intake:write, and unexpired: legacy rows with a NULL expiry
 * stay valid, and a row whose expiresAt is NOT strictly after the current
 * instant is rejected (expiresAt <= now means expired). The check runs
 * before any idempotency or domain write in the intake route.
 */
export const isIntakeToken = async (
  environment: Env,
  token: string,
): Promise<null | { id: string }> => {
  const tokenHash = await hashToken(token);
  const record = await getDatabase(environment)
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        eq(apiTokens.type, 'api'),
        eq(apiTokens.scope, 'intake:write'),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now())),
      ),
    )
    .get();
  if (!record) {
    return null;
  }

  await getDatabase(environment)
    .update(apiTokens)
    .set({ lastUsedAt: now() })
    .where(eq(apiTokens.id, record.id))
    .run();
  return record;
};

/**
 * A browser intake token is write-only: it can create a lead through
 * `/v1/public/intakes/:token` and nothing else. Returns the token row
 * (id used as lead provenance) or null. The value is stored verbatim
 * because browser tokens are safe to embed and copy.
 */
export const isBrowserIntakeToken = async (
  environment: Env,
  token: string,
): Promise<null | { id: string }> => {
  const record = await getDatabase(environment)
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.token, token),
        eq(apiTokens.type, 'browser'),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now())),
      ),
    )
    .get();
  if (!record) {
    return null;
  }

  await getDatabase(environment)
    .update(apiTokens)
    .set({ lastUsedAt: now() })
    .where(eq(apiTokens.id, record.id))
    .run();
  return record;
};

export type StoredIntakeKey = {
  requestHash: null | string;
  responseJson: Record<string, unknown>;
};

export const getIntakeKey = async (
  environment: Env,
  idempotencyKey: string,
): Promise<null | StoredIntakeKey> => {
  const row = await getDatabase(environment)
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(idempotencyKeys.key, idempotencyKey),
      ),
    )
    .get();
  return row
    ? {
        requestHash: row.requestHash,
        responseJson: row.responseJson as Record<string, unknown>,
      }
    : null;
};

const checkStoredIntakeKey = (
  stored: null | StoredIntakeKey,
  requestHash: string,
): 'conflict' | 'legacy_unverifiable' | 'none' | 'replay' => {
  if (!stored) {
    return 'none';
  }

  if (stored.requestHash === null) {
    return 'legacy_unverifiable';
  }

  if (stored.requestHash === requestHash) {
    return 'replay';
  }

  return 'conflict';
};

export type IntakePersistenceOutcome =
  | { kind: 'conflict' }
  | { kind: 'created'; response: IntakeResponse }
  | { kind: 'legacy_unverifiable'; storedResponse: Record<string, unknown> }
  | { kind: 'replayed'; response: IntakeResponse };

/**
 * Interprets an already stored key for this request. Returns undefined when
 * no accepted row exists (i.e. this is a new submission). Used both before
 * the first write and after a batch collision, so concurrent callers apply
 * the exact same replay/conflict/legacy rules.
 */
export const outcomeForStoredIntakeKey = (
  stored: null | StoredIntakeKey,
  requestHash: string,
): IntakePersistenceOutcome | undefined => {
  if (stored === null) {
    return undefined;
  }

  switch (checkStoredIntakeKey(stored, requestHash)) {
    case 'conflict':
      return { kind: 'conflict' };
    case 'legacy_unverifiable':
      return {
        kind: 'legacy_unverifiable',
        storedResponse: stored.responseJson,
      };
    case 'replay':
      return {
        kind: 'replayed',
        response: stored.responseJson as unknown as IntakeResponse,
      };
    default:
      return undefined;
  }
};

export const createLeadAtomically = async (
  environment: Env,
  input: IntakeInput,
  idempotencyKey: string,
  requestHash: string,
  provenance?: { origin: null | string; tokenId: null | string },
  rawPayload?: unknown,
): Promise<IntakePersistenceOutcome> => {
  // Raw D1 binds do not accept Date, so work in Unix milliseconds directly.
  const timestamp = now().getTime();
  const leadId = id();
  const activityId = id();
  const email = normalizeEmail(input.email);
  const response: IntakeResponse = { created: true, leadId };
  const statements: D1PreparedStatement[] = [
    environment.DB.prepare(
      `INSERT INTO leads (
          id, workspace_id, email, first_name, last_name,
          source, estimated_value, custom_fields, raw_payload, skipped_fields,
          origin, token_id, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      leadId,
      DEFAULT_WORKSPACE_ID,
      email,
      input.firstName ?? null,
      input.lastName ?? null,
      input.source,
      input.estimatedValue ?? null,
      JSON.stringify(input.customFields ?? {}),
      rawPayload === undefined ? null : JSON.stringify(rawPayload),
      input.skippedFields ? JSON.stringify(input.skippedFields) : null,
      provenance?.origin ?? null,
      provenance?.tokenId ?? null,
      timestamp,
      timestamp,
    ),
    environment.DB.prepare(
      `INSERT INTO activities (
          id, workspace_id, lead_id, kind, body, metadata, created_at
        ) VALUES (?, ?, ?, 'intake', ?, ?, ?)`,
    ).bind(
      activityId,
      DEFAULT_WORKSPACE_ID,
      leadId,
      `Received from ${input.source}`,
      JSON.stringify({ source: input.source }),
      timestamp,
    ),
    environment.DB.prepare(
      'INSERT INTO idempotency_keys (workspace_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(
      DEFAULT_WORKSPACE_ID,
      idempotencyKey,
      requestHash,
      JSON.stringify(response),
      timestamp,
    ),
  ];

  try {
    await environment.DB.batch(statements);
    return { kind: 'created', response };
  } catch (error) {
    // A unique-key collision means a concurrent request already committed
    // this key; any other failure committed nothing. Re-read and apply the
    // SAME fingerprint/legacy rules as the fast path — never an
    // unconditional replay — then surface the original error if no accepted
    // row exists.
    const stored = await getIntakeKey(environment, idempotencyKey);
    const outcome = outcomeForStoredIntakeKey(stored, requestHash);
    if (outcome) {
      return outcome;
    }

    throw error;
  }
};

export const createLead = async (
  environment: Env,
  input: CreateLeadInput,
): Promise<LeadRecord> => {
  const timestamp = now();
  const email = input.email ? normalizeEmail(input.email) : null;
  const firstName = input.firstName ?? null;
  const lastName = input.lastName ?? null;
  const record: typeof leads.$inferSelect = {
    createdAt: timestamp,
    customFields: input.customFields ?? {},
    deletedAt: null,
    email,
    estimatedValue: input.estimatedValue ?? null,
    firstName,
    id: id(),
    lastName,
    origin: null,
    rawPayload: null,
    skippedFields: null,
    source: input.source ?? 'Manual entry',
    tokenId: null,
    updatedAt: timestamp,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(leads).values(record);
  return toLead({ ...record, duplicateCount: 0 });
};

export const updateLead = async (
  environment: Env,
  leadId: string,
  input: UpdateLeadInput,
): Promise<LeadRecord | null> => {
  const patch: Partial<typeof leads.$inferInsert> = { updatedAt: now() };
  if (input.customFields !== undefined) {
    patch.customFields = input.customFields;
  }

  if (input.email !== undefined) {
    patch.email = input.email ? normalizeEmail(input.email) : null;
  }

  if (input.estimatedValue !== undefined) {
    patch.estimatedValue = input.estimatedValue;
  }

  if (input.firstName !== undefined) {
    patch.firstName = input.firstName;
  }

  if (input.lastName !== undefined) {
    patch.lastName = input.lastName;
  }

  if (input.source !== undefined) {
    patch.source = input.source;
  }

  const result = await getDatabase(environment)
    .update(leads)
    .set(patch)
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(leads.id, leadId),
        isNull(leads.deletedAt),
      ),
    )
    .run();
  if (result.meta.changes === 0) {
    return null;
  }

  return getLead(environment, leadId);
};

export const softDeleteLeads = async (
  environment: Env,
  ids: readonly string[],
): Promise<number> => {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return 0;
  }

  // One statement stays atomic without a batch, and the id list travels as a
  // single JSON array parameter, so no variable-length binding can hit D1's
  // 100-parameter cap. json_each is the documented D1 pattern for IN queries:
  // https://developers.cloudflare.com/d1/sql-api/query-json/#expand-arrays-for-in-queries
  const result = await getDatabase(environment)
    .update(leads)
    .set({ deletedAt: now() })
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        isNull(leads.deletedAt),
        sql`${leads.id} IN (SELECT value FROM json_each(${JSON.stringify(uniqueIds)}))`,
      ),
    )
    .run();
  return result.meta.changes;
};

export const createLeadActivity = async (
  environment: Env,
  leadId: string,
  actorEmail: string,
  kind: string,
  body: string,
) => {
  const lead = await getLead(environment, leadId);
  if (!lead) {
    return null;
  }

  const record = {
    actorEmail,
    body,
    createdAt: now(),
    id: id(),
    kind,
    leadId,
    metadata: {},
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(activities).values(record);
  return record;
};
