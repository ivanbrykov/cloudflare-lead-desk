import {
  activities,
  apiTokens,
  bootstrapState,
  idempotencyKeys,
  leads,
  pipelines,
  session,
  staffInvites,
  stages,
  user,
} from './schema';
import { type RegistrationGrant } from '@/auth/registration-repository';
import { type IntakeResponse, leadDisplayName } from '@/domain/intake';
import { encodeKeysetCursor, type Keyset } from '@/domain/pagination';
import {
  type CreateLeadInput,
  type IntakeInput,
  normalizeEmail,
  type UpdateLeadInput,
} from '@/domain/schemas';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
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
export const DEFAULT_PIPELINE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
export const DEFAULT_STAGE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

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

const escapeLike = (value: string) =>
  value.replaceAll('%', '\\%').replaceAll('_', '\\_');

/**
 * Literal substring match on first name, last name, or email; `%` and `_`
 * in the query are escaped so they never act as LIKE wildcards.
 */
export type LeadPage = {
  leads: LeadRecord[];
  nextCursor: null | string;
};

export type LeadPageOptions = {
  cursor?: Keyset | null;
  limit: number;
  pipelineId?: string;
  query?: string;
  stageId?: string;
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
  name: string;
  pipelineId: string;
  source: string;
  stageId: string;
  updatedAt: Date;
};

/**
 * Literal substring match on the lead name, email, or first/last name; `%` and
 * `_` in the query are escaped so they never act as LIKE wildcards.
 */
const leadSearchPredicate = (query: string) => {
  const pattern = `%${escapeLike(query)}%`;
  return sql`(${leads.name} LIKE ${pattern} ESCAPE '\\' OR ${leads.email} LIKE ${pattern} ESCAPE '\\' OR ${leads.firstName} LIKE ${pattern} ESCAPE '\\' OR ${leads.lastName} LIKE ${pattern} ESCAPE '\\')`;
};

/**
 * How many live leads share each normalized email on the requested page. One
 * grouped query per page; the duplicate hint is intentionally non-authoritative
 * (no uniqueness constraint, per the leads-only design).
 */
const duplicateCountsForEmails = async (
  environment: Env,
  normalizedEmails: Array<null | string>,
): Promise<Map<string, number>> => {
  const emails = [
    ...new Set(
      normalizedEmails.filter(
        (email): email is string => typeof email === 'string',
      ),
    ),
  ];
  if (emails.length === 0) {
    return new Map();
  }

  const rows = await getDatabase(environment)
    .select({ count: sql<number>`count(*)`, email: leads.normalizedEmail })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        isNull(leads.deletedAt),
        inArray(leads.normalizedEmail, emails),
      ),
    )
    .groupBy(leads.normalizedEmail);
  return new Map(
    rows
      .filter(
        (row): row is { count: number; email: string } => row.email !== null,
      )
      .map((row) => [row.email, Number(row.count)]),
  );
};

const toLead = (
  row: typeof leads.$inferSelect,
  duplicateCounts: Map<string, number>,
): LeadRecord => ({
  createdAt: row.createdAt,
  customFields: row.customFields,
  deletedAt: row.deletedAt,
  duplicateCount: row.normalizedEmail
    ? Math.max(0, (duplicateCounts.get(row.normalizedEmail) ?? 1) - 1)
    : 0,
  email: row.email,
  estimatedValue: row.estimatedValue,
  firstName: row.firstName,
  id: row.id,
  lastName: row.lastName,
  name: row.name,
  pipelineId: row.pipelineId,
  source: row.source,
  stageId: row.stageId,
  updatedAt: row.updatedAt,
});

/**
 * Keyset (seek) pagination over (created_at DESC, id DESC), excluding
 * soft-deleted leads. One extra row detects a following page without a COUNT.
 */
export const listLeads = async (
  environment: Env,
  options: LeadPageOptions,
): Promise<LeadPage> => {
  const { cursor, limit, pipelineId, query, stageId } = options;
  const predicates = [
    eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
    isNull(leads.deletedAt),
  ];
  if (pipelineId) {
    predicates.push(eq(leads.pipelineId, pipelineId));
  }

  if (stageId) {
    predicates.push(eq(leads.stageId, stageId));
  }

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
    .select()
    .from(leads)
    .where(and(...predicates))
    .orderBy(desc(leads.createdAt), desc(leads.id))
    .limit(limit + 1);
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const duplicateCounts = await duplicateCountsForEmails(
    environment,
    pageRows.map((row) => row.normalizedEmail),
  );
  const last = pageRows.at(-1);
  return {
    leads: pageRows.map((row) => toLead(row, duplicateCounts)),
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
    .select()
    .from(leads)
    .where(
      and(eq(leads.workspaceId, DEFAULT_WORKSPACE_ID), eq(leads.id, leadId)),
    )
    .get();
  if (!row) {
    return null;
  }

  const duplicateCounts = await duplicateCountsForEmails(environment, [
    row.normalizedEmail,
  ]);
  return toLead(row, duplicateCounts);
};

export const countLeadsByStage = async (
  environment: Env,
  pipelineId?: string,
): Promise<Array<{ count: number; stageId: string }>> => {
  const predicates = [
    eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
    isNull(leads.deletedAt),
  ];
  if (pipelineId) {
    predicates.push(eq(leads.pipelineId, pipelineId));
  }

  const rows = await getDatabase(environment)
    .select({ count: sql<number>`count(*)`, stageId: leads.stageId })
    .from(leads)
    .where(and(...predicates))
    .groupBy(leads.stageId);
  return rows.map((row) => ({
    count: Number(row.count),
    stageId: row.stageId,
  }));
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

// Intake preserves the current workspace defaults rather than inventing new
// routing: a submission without explicit pipeline/stage uses the default
// pipeline and stage bootstrapped by the schema migration.
export const intakePipelineId = (input: IntakeInput): string =>
  input.pipelineId ?? DEFAULT_PIPELINE_ID;
export const intakeStageId = (input: IntakeInput): string =>
  input.stageId ?? DEFAULT_STAGE_ID;

/**
 * A routing pair is valid when the stage exists in the selected pipeline and
 * both belong to the current workspace, and the pipeline is not archived.
 * Defaults are resolved by callers, so this check also covers default
 * routing: archiving the default pipeline rejects default intake.
 */
export const isStageInActiveWorkspacePipeline = async (
  environment: Env,
  pipelineId: string,
  stageId: string,
): Promise<boolean> => {
  const row = await getDatabase(environment)
    .select({ ok: sql<number>`1` })
    .from(stages)
    .innerJoin(pipelines, eq(pipelines.id, stages.pipelineId))
    .where(
      and(
        eq(stages.id, stageId),
        eq(stages.pipelineId, pipelineId),
        eq(stages.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(pipelines.workspaceId, DEFAULT_WORKSPACE_ID),
        isNull(pipelines.archivedAt),
      ),
    )
    .get();
  return row !== undefined;
};

export const getPipeline = async (
  environment: Env,
  pipelineId: string,
): Promise<null | typeof pipelines.$inferSelect> => {
  const row = await getDatabase(environment)
    .select()
    .from(pipelines)
    .where(
      and(
        eq(pipelines.id, pipelineId),
        eq(pipelines.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .get();
  return row ?? null;
};

export const listPipelines = async (environment: Env) => {
  const database = getDatabase(environment);
  const pipelineRows = await database
    .select()
    .from(pipelines)
    .where(eq(pipelines.workspaceId, DEFAULT_WORKSPACE_ID))
    .orderBy(asc(pipelines.name));
  const stageRows = await database
    .select()
    .from(stages)
    .where(eq(stages.workspaceId, DEFAULT_WORKSPACE_ID))
    .orderBy(asc(stages.position));
  return pipelineRows.map((pipeline) => ({
    ...pipeline,
    stages: stageRows.filter((stage) => stage.pipelineId === pipeline.id),
  }));
};

export const createPipeline = async (environment: Env, name: string) => {
  const timestamp = now();
  const pipeline = {
    createdAt: timestamp,
    id: id(),
    name,
    updatedAt: timestamp,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(pipelines).values(pipeline);
  return pipeline;
};

// (pipeline_id, position) is unique (stages_pipeline_position_unique).
// Concurrent creators can read the same max and race for the same slot; the
// loser recomputes from the committed state and retries, bounded so a
// persistent conflict surfaces as a persistence error instead of looping.
const STAGE_CREATE_MAX_ATTEMPTS = 10;

const isStagePositionConflict = (error: unknown): boolean => {
  const visit = (candidate: unknown): boolean => {
    if (!(candidate instanceof Error)) {
      return false;
    }

    if (
      candidate.message.includes('UNIQUE constraint failed') &&
      candidate.message.includes('stages.pipeline_id') &&
      candidate.message.includes('stages.position')
    ) {
      return true;
    }

    const cause = (candidate as { cause?: unknown }).cause;
    return cause !== undefined && cause !== candidate && visit(cause);
  };

  return visit(error);
};

export const createStage = async (
  environment: Env,
  pipelineId: string,
  input: { color?: string; name: string; position?: number },
) => {
  for (let attempt = 1; attempt <= STAGE_CREATE_MAX_ATTEMPTS; attempt += 1) {
    const timestamp = now();
    const max = await getDatabase(environment)
      .select({ position: sql<number>`max(${stages.position})` })
      .from(stages)
      .where(eq(stages.pipelineId, pipelineId))
      .get();
    const stage = {
      color: input.color ?? 'slate',
      createdAt: timestamp,
      id: id(),
      name: input.name,
      pipelineId,
      position: input.position ?? (max?.position ?? -1) + 1,
      updatedAt: timestamp,
      workspaceId: DEFAULT_WORKSPACE_ID,
    };
    try {
      await getDatabase(environment).insert(stages).values(stage);
      return stage;
    } catch (error) {
      // Only a computed position is retryable: an explicit colliding
      // position (or a same-name conflict) will keep failing on recompute.
      if (
        input.position === undefined &&
        isStagePositionConflict(error) &&
        attempt < STAGE_CREATE_MAX_ATTEMPTS
      ) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('unreachable: stage creation exhausted its bounded attempts');
};

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
  name: string,
  expiresAt?: string,
) => {
  const raw = `cld_${crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '')}`;
  const tokenHash = await hashToken(raw);
  const record = {
    createdAt: now(),
    expiresAt:
      expiresAt === undefined
        ? new Date(Date.now() + TOKEN_DEFAULT_TTL_MS)
        : new Date(expiresAt),
    id: id(),
    name,
    prefix: raw.slice(0, 12),
    scope: 'intake:write',
    tokenHash,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(apiTokens).values(record);
  // Return only the public projection plus the raw token, which is shown
  // exactly once. The hash and workspace id stay server-side.
  return {
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    revokedAt: null,
    scope: record.scope,
    token: raw,
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
  const raw = `cld_${crypto
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
): Promise<boolean> => {
  const tokenHash = await hashToken(token);
  const record = await getDatabase(environment)
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        eq(apiTokens.scope, 'intake:write'),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now())),
      ),
    )
    .get();
  if (!record) {
    return false;
  }

  await getDatabase(environment)
    .update(apiTokens)
    .set({ lastUsedAt: now() })
    .where(eq(apiTokens.id, record.id))
    .run();
  return true;
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
): Promise<IntakePersistenceOutcome> => {
  // Raw D1 binds do not accept Date, so work in Unix milliseconds directly.
  const timestamp = now().getTime();
  const leadId = id();
  const activityId = id();
  const email = normalizeEmail(input.email);
  const pipelineId = intakePipelineId(input);
  const stageId = intakeStageId(input);
  const response: IntakeResponse = { created: true, leadId };
  const statements: D1PreparedStatement[] = [
    environment.DB.prepare(
      `INSERT INTO leads (
          id, workspace_id, pipeline_id, stage_id, email, normalized_email,
          first_name, last_name, name, source, estimated_value, custom_fields,
          origin, public_key_id, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
    ).bind(
      leadId,
      DEFAULT_WORKSPACE_ID,
      pipelineId,
      stageId,
      input.email,
      email,
      input.firstName ?? null,
      input.lastName ?? null,
      leadDisplayName(input),
      input.source,
      input.estimatedValue ?? null,
      JSON.stringify(input.customFields ?? {}),
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

const leadName = (parts: {
  email: null | string;
  firstName: null | string;
  lastName: null | string;
  name?: string;
}): string => {
  if (parts.name) {
    return parts.name;
  }

  const person = [parts.firstName, parts.lastName]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .trim();
  return person || parts.email || 'New lead';
};

export const createLead = async (
  environment: Env,
  input: CreateLeadInput,
): Promise<LeadRecord> => {
  const timestamp = now();
  const email = input.email ?? null;
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
    name: leadName({ email, firstName, lastName, name: input.name }),
    normalizedEmail: email ? normalizeEmail(email) : null,
    origin: null,
    pipelineId: input.pipelineId ?? DEFAULT_PIPELINE_ID,
    publicKeyId: null,
    source: input.source ?? 'Manual entry',
    stageId: input.stageId ?? DEFAULT_STAGE_ID,
    updatedAt: timestamp,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(leads).values(record);
  return toLead(record, new Map());
};

export const updateLead = async (
  environment: Env,
  leadId: string,
  input: UpdateLeadInput,
): Promise<'invalid_stage' | LeadRecord | null> => {
  const existing = await getDatabase(environment)
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        eq(leads.id, leadId),
        isNull(leads.deletedAt),
      ),
    )
    .get();
  if (!existing) {
    return null;
  }

  const patch: Partial<typeof leads.$inferInsert> = { updatedAt: now() };
  if (input.customFields !== undefined) {
    patch.customFields = input.customFields;
  }

  if (input.email !== undefined) {
    patch.email = input.email;
    patch.normalizedEmail = input.email ? normalizeEmail(input.email) : null;
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

  if (input.name !== undefined) {
    patch.name = input.name;
  }

  if (input.source !== undefined) {
    patch.source = input.source;
  }

  if (input.stageId !== undefined) {
    const valid = await isStageInActiveWorkspacePipeline(
      environment,
      existing.pipelineId,
      input.stageId,
    );
    if (!valid) {
      return 'invalid_stage';
    }

    patch.stageId = input.stageId;
  }

  await getDatabase(environment)
    .update(leads)
    .set(patch)
    .where(
      and(eq(leads.workspaceId, DEFAULT_WORKSPACE_ID), eq(leads.id, leadId)),
    )
    .run();
  return getLead(environment, leadId);
};

/**
 * Bulk stage move for the selected table rows. The stage must belong to the
 * same pipeline as every selected lead; leads may not span pipelines.
 */
export const moveLeads = async (
  environment: Env,
  ids: readonly string[],
  stageId: string,
): Promise<'invalid_stage' | 'moved' | 'not_found'> => {
  const uniqueIds = [...new Set(ids)];
  const rows = await getDatabase(environment)
    .select({ id: leads.id, pipelineId: leads.pipelineId })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        isNull(leads.deletedAt),
        inArray(leads.id, uniqueIds),
      ),
    );
  if (rows.length !== uniqueIds.length) {
    return 'not_found';
  }

  const stage = await getDatabase(environment)
    .select({ pipelineId: stages.pipelineId })
    .from(stages)
    .where(
      and(eq(stages.id, stageId), eq(stages.workspaceId, DEFAULT_WORKSPACE_ID)),
    )
    .get();
  if (!stage || rows.some((row) => row.pipelineId !== stage.pipelineId)) {
    return 'invalid_stage';
  }

  await getDatabase(environment)
    .update(leads)
    .set({ stageId, updatedAt: now() })
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        isNull(leads.deletedAt),
        inArray(leads.id, uniqueIds),
      ),
    )
    .run();
  return 'moved';
};

export const softDeleteLeads = async (
  environment: Env,
  ids: readonly string[],
): Promise<number> => {
  const uniqueIds = [...new Set(ids)];
  const result = await getDatabase(environment)
    .update(leads)
    .set({ deletedAt: now() })
    .where(
      and(
        eq(leads.workspaceId, DEFAULT_WORKSPACE_ID),
        isNull(leads.deletedAt),
        inArray(leads.id, uniqueIds),
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
    contactId: null,
    createdAt: now(),
    id: id(),
    kind,
    leadId,
    metadata: {},
    opportunityId: null,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDatabase(environment).insert(activities).values(record);
  return record;
};
