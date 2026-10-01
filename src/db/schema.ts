import { user } from './auth-schema';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// App-owned timestamps store Unix milliseconds (the Better Auth convention)
// and read back as Date values. API responses serialize them to ISO-8601.
const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const workspaces = sqliteTable('workspaces', {
  createdAt: timestampMs('created_at').notNull(),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  updatedAt: timestampMs('updated_at').notNull(),
});

export const leads = sqliteTable(
  'leads',
  {
    createdAt: timestampMs('created_at').notNull(),
    customFields: text('custom_fields', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    deletedAt: timestampMs('deleted_at'),
    email: text('email'),
    estimatedValue: integer('estimated_value'),
    firstName: text('first_name'),
    id: text('id').primaryKey(),
    lastName: text('last_name'),
    origin: text('origin'),
    rawPayload: text('raw_payload', { mode: 'json' }).$type<
      Record<string, unknown>
    >(),
    skippedFields: text('skipped_fields', { mode: 'json' }).$type<
      Array<{ name: string; reason: 'sensitive' | 'unmarked' }>
    >(),
    source: text('source').notNull(),
    tokenId: text('token_id'),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('leads_email_idx').on(table.workspaceId, table.email),
    // The flat leads list orders by createdAt, so it gets its own index.
    index('leads_workspace_created_idx').on(table.workspaceId, table.createdAt),
  ],
);

export const activities = sqliteTable(
  'activities',
  {
    actorEmail: text('actor_email'),
    body: text('body').notNull(),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id),
    metadata: text('metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('activities_lead_created_idx').on(table.leadId, table.createdAt),
  ],
);

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    createdAt: timestampMs('created_at').notNull(),
    expiresAt: timestampMs('expires_at'),
    id: text('id').primaryKey(),
    lastUsedAt: timestampMs('last_used_at'),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    revokedAt: timestampMs('revoked_at'),
    scope: text('scope').notNull().default('intake:write'),
    // Browser tokens are safe to embed, so the value is stored and copyable.
    // API tokens are secrets: only the hash is stored.
    token: text('token').unique(),
    tokenHash: text('token_hash').unique(),
    type: text('type', { enum: ['api', 'browser'] })
      .notNull()
      .default('api'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [index('api_tokens_workspace_idx').on(table.workspaceId)],
);

// Single-use staff invitations. The token itself is never stored; only its
// hash plus a short prefix for display. Timestamps are Unix milliseconds
// (same convention as api_tokens).
export const staffInvites = sqliteTable('staff_invites', {
  createdAt: timestampMs('created_at').notNull(),
  expiresAt: timestampMs('expires_at').notNull(),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  revokedAt: timestampMs('revoked_at'),
  tokenHash: text('token_hash').notNull().unique(),
  usedAt: timestampMs('used_at'),
  usedByUserId: text('used_by_user_id').references(() => user.id, {
    onDelete: 'set null',
  }),
});

// One-row bootstrap invite state. The check keeps the table a singleton;
// the seed row is inserted by migration 0004 (INSERT OR IGNORE, so reruns
// never refresh or reopen it).
export const bootstrapState = sqliteTable(
  'bootstrap_state',
  {
    consumedAt: timestampMs('consumed_at'),
    createdAt: timestampMs('created_at').notNull(),
    expiresAt: timestampMs('expires_at').notNull(),
    id: text('id').primaryKey(),
  },
  () => [check('bootstrap_state_default_only', sql`id = 'default'`)],
);

// Durable single-use ledger for registration redemption (migration 0005).
// The UNIQUE claim_key is the race guard: two concurrent redemptions of the
// same grant cannot both insert, and the loser's batch rolls back in full.
// The grant-guard trigger (migration 0005) re-validates grant eligibility
// inside the redemption batch, so a grant that is revoked, used, or expires
// between the pre-check and the batch still fails atomically. The claim row
// deliberately survives user deletion (ON DELETE SET NULL): a deleted
// bootstrap user must not reopen the bootstrap grant.
export const registrationClaims = sqliteTable('registration_claims', {
  claimKey: text('claim_key').notNull().unique(),
  createdAt: timestampMs('created_at').notNull(),
  grantKind: text('grant_kind').notNull(),
  grantRef: text('grant_ref').notNull(),
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
});

// Better Auth tables (user, session, account, verification). Generated by the
// Better Auth CLI into ./auth-schema.ts; see src/auth/cli.ts.
export * from './auth-schema';

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    createdAt: timestampMs('created_at').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash'),
    responseJson: text('response_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    uniqueIndex('idempotency_workspace_key_unique').on(
      table.workspaceId,
      table.key,
    ),
  ],
);
