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

export const pipelines = sqliteTable(
  'pipelines',
  {
    archivedAt: timestampMs('archived_at'),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    uniqueIndex('pipelines_workspace_name_unique').on(
      table.workspaceId,
      table.name,
    ),
  ],
);

export const stages = sqliteTable(
  'stages',
  {
    color: text('color').notNull().default('slate'),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id),
    position: integer('position').notNull(),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('stages_pipeline_position_idx').on(table.pipelineId, table.position),
    uniqueIndex('stages_pipeline_position_unique').on(
      table.pipelineId,
      table.position,
    ),
    uniqueIndex('stages_pipeline_name_unique').on(table.pipelineId, table.name),
  ],
);

export const contacts = sqliteTable(
  'contacts',
  {
    createdAt: timestampMs('created_at').notNull(),
    email: text('email'),
    firstName: text('first_name'),
    id: text('id').primaryKey(),
    lastName: text('last_name'),
    normalizedEmail: text('normalized_email'),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('contacts_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    uniqueIndex('contacts_workspace_email_unique').on(
      table.workspaceId,
      table.normalizedEmail,
    ),
  ],
);

export const opportunities = sqliteTable(
  'opportunities',
  {
    createdAt: timestampMs('created_at').notNull(),
    deletedAt: timestampMs('deleted_at'),
    estimatedValue: integer('estimated_value'),
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id),
    primaryContactId: text('primary_contact_id')
      .notNull()
      .references(() => contacts.id),
    source: text('source').notNull(),
    stageId: text('stage_id')
      .notNull()
      .references(() => stages.id),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('opportunities_workspace_stage_idx').on(
      table.workspaceId,
      table.stageId,
      table.createdAt,
    ),
    index('opportunities_contact_idx').on(table.primaryContactId),
  ],
);

export const activities = sqliteTable(
  'activities',
  {
    actorEmail: text('actor_email'),
    body: text('body').notNull(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id),
    createdAt: timestampMs('created_at').notNull(),
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    metadata: text('metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    opportunityId: text('opportunity_id').references(() => opportunities.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('activities_contact_created_idx').on(
      table.contactId,
      table.createdAt,
    ),
    index('activities_opportunity_created_idx').on(
      table.opportunityId,
      table.createdAt,
    ),
  ],
);

export const customFieldDefinitions = sqliteTable(
  'custom_field_definitions',
  {
    archivedAt: timestampMs('archived_at'),
    createdAt: timestampMs('created_at').notNull(),
    entityType: text('entity_type', {
      enum: ['contact', 'opportunity'],
    }).notNull(),
    id: text('id').primaryKey(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    options: text('options', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    required: integer('required', { mode: 'boolean' }).notNull().default(false),
    type: text('type', {
      enum: ['text', 'number', 'boolean', 'date', 'select'],
    }).notNull(),
    updatedAt: timestampMs('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('field_definitions_workspace_entity_idx').on(
      table.workspaceId,
      table.entityType,
      table.archivedAt,
    ),
    uniqueIndex('field_definitions_workspace_entity_key_unique').on(
      table.workspaceId,
      table.entityType,
      table.key,
    ),
  ],
);

export const customFieldValues = sqliteTable(
  'custom_field_values',
  {
    createdAt: timestampMs('created_at').notNull(),
    entityId: text('entity_id').notNull(),
    entityType: text('entity_type', {
      enum: ['contact', 'opportunity'],
    }).notNull(),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => customFieldDefinitions.id),
    id: text('id').primaryKey(),
    updatedAt: timestampMs('updated_at').notNull(),
    valueBoolean: integer('value_boolean'),
    valueDate: text('value_date'),
    valueNumber: integer('value_number'),
    valueText: text('value_text'),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('field_values_entity_idx').on(table.entityType, table.entityId),
    uniqueIndex('field_values_entity_definition_unique').on(
      table.entityType,
      table.entityId,
      table.fieldDefinitionId,
    ),
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
    tokenHash: text('token_hash').notNull().unique(),
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
