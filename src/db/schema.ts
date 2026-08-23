import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  updatedAt: text('updated_at').notNull(),
});

export const pipelines = sqliteTable(
  'pipelines',
  {
    id: text('id').primaryKey(),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    name: text('name').notNull(),
    updatedAt: text('updated_at').notNull(),
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
    createdAt: text('created_at').notNull(),
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id),
    position: integer('position').notNull(),
    updatedAt: text('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('stages_pipeline_position_idx').on(table.pipelineId, table.position),
    uniqueIndex('stages_pipeline_name_unique').on(table.pipelineId, table.name),
  ],
);

export const contacts = sqliteTable(
  'contacts',
  {
    createdAt: text('created_at').notNull(),
    email: text('email'),
    firstName: text('first_name'),
    id: text('id').primaryKey(),
    lastName: text('last_name'),
    normalizedEmail: text('normalized_email'),
    updatedAt: text('updated_at').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index('contacts_workspace_created_idx').on(table.workspaceId, table.createdAt),
    uniqueIndex('contacts_workspace_email_unique').on(
      table.workspaceId,
      table.normalizedEmail,
    ),
  ],
);

export const opportunities = sqliteTable(
  'opportunities',
  {
    createdAt: text('created_at').notNull(),
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
    updatedAt: text('updated_at').notNull(),
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
    createdAt: text('created_at').notNull(),
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
    index('activities_contact_created_idx').on(table.contactId, table.createdAt),
    index('activities_opportunity_created_idx').on(
      table.opportunityId,
      table.createdAt,
    ),
  ],
);

export const customFieldDefinitions = sqliteTable(
  'custom_field_definitions',
  {
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    entityType: text('entity_type', { enum: ['contact', 'opportunity'] }).notNull(),
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
    updatedAt: text('updated_at').notNull(),
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
    createdAt: text('created_at').notNull(),
    entityId: text('entity_id').notNull(),
    entityType: text('entity_type', { enum: ['contact', 'opportunity'] }).notNull(),
    fieldDefinitionId: text('field_definition_id')
      .notNull()
      .references(() => customFieldDefinitions.id),
    id: text('id').primaryKey(),
    updatedAt: text('updated_at').notNull(),
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
    createdAt: text('created_at').notNull(),
    id: text('id').primaryKey(),
    lastUsedAt: text('last_used_at'),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    revokedAt: text('revoked_at'),
    scope: text('scope').notNull().default('intake:write'),
    tokenHash: text('token_hash').notNull().unique(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [index('api_tokens_workspace_idx').on(table.workspaceId)],
);

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    createdAt: text('created_at').notNull(),
    key: text('key').notNull(),
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
