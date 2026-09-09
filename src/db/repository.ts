import { and, asc, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { CustomFieldWrite, NormalizedFieldValue } from '@/domain/custom-fields';
import type { IntakeResponse } from '@/domain/intake';
import type {
  ContactInput,
  CreateCustomField,
  FieldEntity,
  IntakeInput,
  CreateOpportunityInput,
  OpportunityInput,
} from '@/domain/schemas';
import { normalizeEmail } from '@/domain/schemas';
import {
  activities,
  apiTokens,
  contacts,
  customFieldDefinitions,
  customFieldValues,
  idempotencyKeys,
  opportunities,
  pipelines,
  stages,
  workspaces,
} from './schema';

export interface Env {
  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
  ASSETS: Fetcher;
  DB: D1Database;
  DEV_ADMIN_EMAIL?: string;
  ENVIRONMENT: 'development' | 'production' | 'test';
}

export const DEFAULT_WORKSPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const DEFAULT_PIPELINE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
export const DEFAULT_STAGE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const now = (): string => new Date().toISOString();
const id = (): string => {
  let timestamp = Date.now();
  let result = '';
  for (let index = 0; index < 10; index += 1) {
    result = ULID_ALPHABET[timestamp % 32] + result;
    timestamp = Math.floor(timestamp / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  return result + Array.from(random, (value) => ULID_ALPHABET[value % 32]).join('');
};

export interface ContactRecord {
  createdAt: string;
  email: string | null;
  firstName: string | null;
  id: string;
  lastName: string | null;
  updatedAt: string;
}

export interface OpportunityRecord {
  contact: ContactRecord;
  createdAt: string;
  estimatedValue: number | null;
  id: string;
  name: string;
  pipelineId: string;
  source: string;
  stageId: string;
  updatedAt: string;
}

export interface FieldDefinitionRecord {
  archivedAt: string | null;
  entityType: FieldEntity;
  id: string;
  key: string;
  label: string;
  options: string[];
  required: boolean;
  type: 'boolean' | 'date' | 'number' | 'select' | 'text';
}

export const seedDefaults = async (env: Env): Promise<void> => {
  const timestamp = now();
  await env.DB.batch([
    env.DB
      .prepare(
        'INSERT OR IGNORE INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        DEFAULT_WORKSPACE_ID,
        'default',
        'Lead Desk',
        timestamp,
        timestamp,
      ),
    env.DB
      .prepare(
        'INSERT OR IGNORE INTO pipelines (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        DEFAULT_PIPELINE_ID,
        DEFAULT_WORKSPACE_ID,
        'Sales',
        timestamp,
        timestamp,
      ),
    env.DB
      .prepare(
        'INSERT OR IGNORE INTO stages (id, workspace_id, pipeline_id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        DEFAULT_STAGE_ID,
        DEFAULT_WORKSPACE_ID,
        DEFAULT_PIPELINE_ID,
        'New inquiry',
        'blue',
        0,
        timestamp,
        timestamp,
      ),
  ]);
};

const getDb = (env: Env) => drizzle(env.DB);

export const getFieldDefinitions = async (
  env: Env,
  entityType: FieldEntity,
  includeArchived = false,
): Promise<FieldDefinitionRecord[]> => {
  const db = getDb(env);
  const predicates = [
    eq(customFieldDefinitions.workspaceId, DEFAULT_WORKSPACE_ID),
    eq(customFieldDefinitions.entityType, entityType),
  ];
  if (!includeArchived) predicates.push(isNull(customFieldDefinitions.archivedAt));
  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(...predicates))
    .orderBy(asc(customFieldDefinitions.label));

  return rows.map((row) => ({
    archivedAt: row.archivedAt,
    entityType: row.entityType as FieldEntity,
    id: row.id,
    key: row.key,
    label: row.label,
    options: row.options,
    required: row.required,
    type: row.type as FieldDefinitionRecord['type'],
  }));
};

/**
 * Reads expose active field definitions only. Values stored under archived
 * definitions remain in `custom_field_values` for historical export but are
 * excluded from editable payloads, so an archived value never blocks edits.
 */
const valuesForEntity = async (
  env: Env,
  entityType: FieldEntity,
  entityId: string,
): Promise<Record<string, unknown>> => {
  const db = getDb(env);
  const rows = await db
    .select({
      key: customFieldDefinitions.key,
      type: customFieldDefinitions.type,
      valueBoolean: customFieldValues.valueBoolean,
      valueDate: customFieldValues.valueDate,
      valueNumber: customFieldValues.valueNumber,
      valueText: customFieldValues.valueText,
    })
    .from(customFieldValues)
    .innerJoin(
      customFieldDefinitions,
      eq(customFieldValues.fieldDefinitionId, customFieldDefinitions.id),
    )
    .where(
      and(
        eq(customFieldValues.entityType, entityType),
        eq(customFieldValues.entityId, entityId),
        isNull(customFieldDefinitions.archivedAt),
      ),
    );

  return Object.fromEntries(
    rows.map((row) => [
      row.key,
      // Boolean fields are stored as 0/1 in SQLite; decode by definition type
      // so false round-trips as a real JSON boolean.
      row.type === 'boolean'
        ? Boolean(row.valueBoolean)
        : row.type === 'number'
          ? row.valueNumber
          : row.type === 'date'
            ? row.valueDate
            : row.valueText,
    ]),
  );
};

const upsertFieldValue = (
  env: Env,
  entityType: FieldEntity,
  entityId: string,
  value: NormalizedFieldValue,
  timestamp: string,
): D1PreparedStatement =>
  env.DB
    .prepare(
      `INSERT INTO custom_field_values (
        id, workspace_id, entity_type, entity_id, field_definition_id,
        value_text, value_number, value_boolean, value_date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id, field_definition_id) DO UPDATE SET
        value_text = excluded.value_text,
        value_number = excluded.value_number,
        value_boolean = excluded.value_boolean,
        value_date = excluded.value_date,
        updated_at = excluded.updated_at`,
    )
    .bind(
      id(),
      DEFAULT_WORKSPACE_ID,
      entityType,
      entityId,
      value.fieldId,
      value.valueText,
      value.valueNumber,
      value.valueBoolean,
      value.valueDate,
      timestamp,
      timestamp,
    );

const deleteFieldValue = (
  env: Env,
  entityType: FieldEntity,
  entityId: string,
  fieldId: string,
): D1PreparedStatement =>
  env.DB
    .prepare(
      'DELETE FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_definition_id = ? AND workspace_id = ?',
    )
    .bind(entityType, entityId, fieldId, DEFAULT_WORKSPACE_ID);

const fieldWriteStatements = (
  env: Env,
  entityType: FieldEntity,
  entityId: string,
  writes: CustomFieldWrite[],
  timestamp: string,
): D1PreparedStatement[] =>
  writes.flatMap((write) =>
    write.kind === 'set'
      ? [upsertFieldValue(env, entityType, entityId, write, timestamp)]
      : [deleteFieldValue(env, entityType, entityId, write.fieldId)],
  );

export const listContacts = async (
  env: Env,
  query?: string,
): Promise<Array<ContactRecord & { customFields: Record<string, unknown> }>> => {
  const db = getDb(env);
  const predicates = [eq(contacts.workspaceId, DEFAULT_WORKSPACE_ID)];
  if (query) {
    const escaped = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    predicates.push(
      sql`(${contacts.firstName} LIKE ${escaped} ESCAPE '\\' OR ${contacts.lastName} LIKE ${escaped} ESCAPE '\\' OR ${contacts.email} LIKE ${escaped} ESCAPE '\\')`,
    );
  }
  const rows = await db
    .select()
    .from(contacts)
    .where(and(...predicates))
    .orderBy(desc(contacts.createdAt));

  return Promise.all(
    rows.map(async (row) => ({
      ...toContact(row),
      customFields: await valuesForEntity(env, 'contact', row.id),
    })),
  );
};

const toContact = (row: typeof contacts.$inferSelect): ContactRecord => ({
  createdAt: row.createdAt,
  email: row.email,
  firstName: row.firstName,
  id: row.id,
  lastName: row.lastName,
  updatedAt: row.updatedAt,
});

export const getContact = async (
  env: Env,
  contactId: string,
): Promise<(ContactRecord & { customFields: Record<string, unknown> }) | null> => {
  const db = getDb(env);
  const row = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .get();
  return row
    ? { ...toContact(row), customFields: await valuesForEntity(env, 'contact', row.id) }
    : null;
};

export const createContact = async (
  env: Env,
  input: ContactInput,
  customFields: CustomFieldWrite[],
): Promise<ContactRecord & { customFields: Record<string, unknown> }> => {
  const timestamp = now();
  const contactId = id();
  const email = input.email ? normalizeEmail(input.email) : null;
  // Core contact and custom-field values commit as one D1 batch, so a failed
  // field write rolls back the whole create instead of orphaning a contact.
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        'INSERT INTO contacts (id, workspace_id, email, normalized_email, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        contactId,
        DEFAULT_WORKSPACE_ID,
        email,
        email,
        input.firstName ?? null,
        input.lastName ?? null,
        timestamp,
        timestamp,
      ),
    ...fieldWriteStatements(env, 'contact', contactId, customFields, timestamp),
  ];
  await env.DB.batch(statements);
  return {
    createdAt: timestamp,
    customFields: await valuesForEntity(env, 'contact', contactId),
    email,
    firstName: input.firstName ?? null,
    id: contactId,
    lastName: input.lastName ?? null,
    updatedAt: timestamp,
  };
};

export const updateContact = async (
  env: Env,
  contactId: string,
  input: ContactInput,
  customFields: CustomFieldWrite[],
): Promise<(ContactRecord & { customFields: Record<string, unknown> }) | null> => {
  const existing = await getContact(env, contactId);
  if (!existing) return null;
  const timestamp = now();
  const email = input.email ? normalizeEmail(input.email) : null;
  // The core update and every field set/clear share one D1 batch, so a
  // failed field write leaves the contact (including updatedAt) unchanged.
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        'UPDATE contacts SET email = ?, first_name = ?, last_name = ?, normalized_email = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      )
      .bind(
        email,
        input.firstName ?? null,
        input.lastName ?? null,
        email,
        timestamp,
        contactId,
        DEFAULT_WORKSPACE_ID,
      ),
    ...fieldWriteStatements(env, 'contact', contactId, customFields, timestamp),
  ];
  await env.DB.batch(statements);
  return getContact(env, contactId);
};

export const deleteContact = async (
  env: Env,
  contactId: string,
): Promise<'deleted' | 'has_opportunities' | 'not_found'> => {
  const db = getDb(env);
  const existing = await getContact(env, contactId);
  if (!existing) return 'not_found';
  const linkedOpportunity = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.primaryContactId, contactId),
        eq(opportunities.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .get();
  if (linkedOpportunity) return 'has_opportunities';
  await db
    .delete(customFieldValues)
    .where(
      and(
        eq(customFieldValues.entityType, 'contact'),
        eq(customFieldValues.entityId, contactId),
        eq(customFieldValues.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .run();
  await db
    .delete(contacts)
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .run();
  return 'deleted';
};

// Intake preserves the current workspace defaults rather than inventing new
// routing: a submission without explicit pipeline/stage uses the seeded
// default pipeline and stage.
export const intakePipelineId = (input: IntakeInput): string =>
  input.opportunity.pipelineId ?? DEFAULT_PIPELINE_ID;
export const intakeStageId = (input: IntakeInput): string =>
  input.opportunity.stageId ?? DEFAULT_STAGE_ID;

/**
 * A routing pair is valid when the stage exists in the selected pipeline and
 * both belong to the current workspace, and the pipeline is not archived.
 * Defaults are resolved by callers, so this check also covers default
 * routing: archiving the default pipeline rejects default intake.
 */
export const isStageInActiveWorkspacePipeline = async (
  env: Env,
  pipelineId: string,
  stageId: string,
): Promise<boolean> => {
  const row = await getDb(env)
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

export const createManualOpportunity = async (
  env: Env,
  input: CreateOpportunityInput,
  contactValues: CustomFieldWrite[],
  opportunityValues: CustomFieldWrite[],
  actorEmail: string,
): Promise<(OpportunityRecord & { customFields: Record<string, unknown> }) | 'contact_not_found' | 'invalid_stage'> => {
  if (input.contactId && !(await getContact(env, input.contactId))) return 'contact_not_found';
  const pipelineId = input.pipelineId ?? DEFAULT_PIPELINE_ID;
  const stageId = input.stageId ?? DEFAULT_STAGE_ID;
  if (!(await isStageInActiveWorkspacePipeline(env, pipelineId, stageId))) return 'invalid_stage';
  const timestamp = now();
  const contactId = input.contactId ?? id();
  const opportunityId = id();
  const statements: D1PreparedStatement[] = [];
  if (input.contact) {
    const email = input.contact.email ? normalizeEmail(input.contact.email) : null;
    statements.push(
      env.DB.prepare('INSERT INTO contacts (id, workspace_id, email, normalized_email, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(contactId, DEFAULT_WORKSPACE_ID, email, email, input.contact.firstName ?? null, input.contact.lastName ?? null, timestamp, timestamp),
    );
  }
  statements.push(
    env.DB.prepare('INSERT INTO opportunities (id, workspace_id, primary_contact_id, pipeline_id, stage_id, name, source, estimated_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(opportunityId, DEFAULT_WORKSPACE_ID, contactId, pipelineId, stageId, input.name, input.source ?? 'manual', input.estimatedValue ?? null, timestamp, timestamp),
    env.DB.prepare('INSERT INTO activities (id, workspace_id, contact_id, opportunity_id, kind, body, actor_email, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id(), DEFAULT_WORKSPACE_ID, contactId, opportunityId, 'manual_entry', 'Created manually', actorEmail, JSON.stringify({ source: input.source ?? 'manual' }), timestamp),
  );
  // A manual opportunity is a creation: clear writes are impossible, and the
  // field statements commit in the same batch as the new records.
  statements.push(
    ...fieldWriteStatements(env, 'contact', contactId, contactValues, timestamp),
    ...fieldWriteStatements(env, 'opportunity', opportunityId, opportunityValues, timestamp),
  );
  await env.DB.batch(statements);
  return (await getOpportunity(env, opportunityId))!;
};

export const listOpportunities = async (
  env: Env,
): Promise<Array<OpportunityRecord & { customFields: Record<string, unknown> }>> => {
  const db = getDb(env);
  const rows = await db
    .select({
      contact: contacts,
      opportunity: opportunities,
    })
    .from(opportunities)
    .innerJoin(contacts, eq(opportunities.primaryContactId, contacts.id))
    .where(eq(opportunities.workspaceId, DEFAULT_WORKSPACE_ID))
    .orderBy(desc(opportunities.createdAt));

  return Promise.all(
    rows.map(async ({ contact, opportunity }) => ({
      contact: toContact(contact),
      createdAt: opportunity.createdAt,
      customFields: await valuesForEntity(env, 'opportunity', opportunity.id),
      estimatedValue: opportunity.estimatedValue,
      id: opportunity.id,
      name: opportunity.name,
      pipelineId: opportunity.pipelineId,
      source: opportunity.source,
      stageId: opportunity.stageId,
      updatedAt: opportunity.updatedAt,
    })),
  );
};

export const getOpportunity = async (
  env: Env,
  opportunityId: string,
): Promise<(OpportunityRecord & { customFields: Record<string, unknown> }) | null> => {
  const db = getDb(env);
  const row = await db
    .select({ contact: contacts, opportunity: opportunities })
    .from(opportunities)
    .innerJoin(contacts, eq(opportunities.primaryContactId, contacts.id))
    .where(
      and(
        eq(opportunities.id, opportunityId),
        eq(opportunities.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .get();
  if (!row) return null;
  return {
    contact: toContact(row.contact),
    createdAt: row.opportunity.createdAt,
    customFields: await valuesForEntity(env, 'opportunity', row.opportunity.id),
    estimatedValue: row.opportunity.estimatedValue,
    id: row.opportunity.id,
    name: row.opportunity.name,
    pipelineId: row.opportunity.pipelineId,
    source: row.opportunity.source,
    stageId: row.opportunity.stageId,
    updatedAt: row.opportunity.updatedAt,
  };
};

export const listPipelines = async (env: Env) => {
  const db = getDb(env);
  const pipelineRows = await db
    .select()
    .from(pipelines)
    .where(eq(pipelines.workspaceId, DEFAULT_WORKSPACE_ID))
    .orderBy(asc(pipelines.name));
  const stageRows = await db
    .select()
    .from(stages)
    .where(eq(stages.workspaceId, DEFAULT_WORKSPACE_ID))
    .orderBy(asc(stages.position));
  return pipelineRows.map((pipeline) => ({
    ...pipeline,
    stages: stageRows.filter((stage) => stage.pipelineId === pipeline.id),
  }));
};

export const createPipeline = async (env: Env, name: string) => {
  const timestamp = now();
  const pipeline = {
    createdAt: timestamp,
    id: id(),
    name,
    updatedAt: timestamp,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDb(env).insert(pipelines).values(pipeline);
  return pipeline;
};

export const createStage = async (
  env: Env,
  pipelineId: string,
  input: { color?: string; name: string; position?: number },
) => {
  const timestamp = now();
  const max = await getDb(env)
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
  await getDb(env).insert(stages).values(stage);
  return stage;
};

export const moveOpportunity = async (
  env: Env,
  opportunityId: string,
  stageId: string,
  actorEmail: string,
) => {
  const opportunity = await getOpportunity(env, opportunityId);
  if (!opportunity) return null;
  const stage = await getDb(env)
    .select()
    .from(stages)
    .where(
      and(eq(stages.id, stageId), eq(stages.pipelineId, opportunity.pipelineId)),
    )
    .get();
  if (!stage) return undefined;
  const timestamp = now();
  await env.DB.batch([
    env.DB
      .prepare('UPDATE opportunities SET stage_id = ?, updated_at = ? WHERE id = ?')
      .bind(stageId, timestamp, opportunityId),
    env.DB
      .prepare(
        'INSERT INTO activities (id, workspace_id, contact_id, opportunity_id, kind, body, actor_email, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id(),
        DEFAULT_WORKSPACE_ID,
        opportunity.contact.id,
        opportunityId,
        'stage_changed',
        `Moved to ${stage.name}`,
        actorEmail,
        JSON.stringify({ stageId }),
        timestamp,
      ),
  ]);
  return getOpportunity(env, opportunityId);
};

export const createActivity = async (
  env: Env,
  opportunityId: string,
  actorEmail: string,
  kind: string,
  body: string,
) => {
  const opportunity = await getOpportunity(env, opportunityId);
  if (!opportunity) return null;
  const activity = {
    actorEmail,
    body,
    contactId: opportunity.contact.id,
    createdAt: now(),
    id: id(),
    kind,
    metadata: {},
    opportunityId,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDb(env).insert(activities).values(activity);
  return activity;
};

export const listActivities = async (env: Env, opportunityId: string) =>
  getDb(env)
    .select()
    .from(activities)
    .where(eq(activities.opportunityId, opportunityId))
    .orderBy(desc(activities.createdAt));

export const createFieldDefinition = async (
  env: Env,
  input: CreateCustomField,
) => {
  const timestamp = now();
  const field = {
    createdAt: timestamp,
    entityType: input.entityType,
    id: id(),
    key: input.key,
    label: input.label,
    options: [...(input.options ?? [])],
    required: input.required ?? false,
    type: input.type,
    updatedAt: timestamp,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDb(env).insert(customFieldDefinitions).values(field);
  return field;
};

export const archiveFieldDefinition = async (env: Env, fieldId: string) => {
  const timestamp = now();
  const result = await getDb(env)
    .update(customFieldDefinitions)
    .set({ archivedAt: timestamp, updatedAt: timestamp })
    .where(
      and(
        eq(customFieldDefinitions.id, fieldId),
        eq(customFieldDefinitions.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .run();
  return result.meta.changes > 0;
};

export const createApiToken = async (env: Env, name: string) => {
  const raw = `cld_${crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((text, byte) => text + byte.toString(16).padStart(2, '0'), '')}`;
  const tokenHash = await hashToken(raw);
  const record = {
    createdAt: now(),
    id: id(),
    name,
    prefix: raw.slice(0, 12),
    scope: 'intake:write',
    tokenHash,
    workspaceId: DEFAULT_WORKSPACE_ID,
  };
  await getDb(env).insert(apiTokens).values(record);
  return { ...record, token: raw };
};

export const listApiTokens = async (env: Env) =>
  getDb(env)
    .select({
      createdAt: apiTokens.createdAt,
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

export const revokeApiToken = async (env: Env, tokenId: string) => {
  const result = await getDb(env)
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

export const isIntakeToken = async (env: Env, token: string): Promise<boolean> => {
  const tokenHash = await hashToken(token);
  const record = await getDb(env)
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        eq(apiTokens.scope, 'intake:write'),
        isNull(apiTokens.revokedAt),
      ),
    )
    .get();
  if (!record) return false;
  await getDb(env)
    .update(apiTokens)
    .set({ lastUsedAt: now() })
    .where(eq(apiTokens.id, record.id))
    .run();
  return true;
};

export interface StoredIntakeKey {
  requestHash: string | null;
  responseJson: Record<string, unknown>;
}

export const getIntakeKey = async (
  env: Env,
  idempotencyKey: string,
): Promise<StoredIntakeKey | null> => {
  const row = await getDb(env)
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
  stored: StoredIntakeKey | null,
  requestHash: string,
): 'none' | 'conflict' | 'legacy_unverifiable' | 'replay' => {
  if (!stored) return 'none';
  if (stored.requestHash === null) return 'legacy_unverifiable';
  if (stored.requestHash === requestHash) return 'replay';
  return 'conflict';
};

export type IntakePersistenceOutcome =
  | { kind: 'created'; response: IntakeResponse }
  | { kind: 'replayed'; response: IntakeResponse }
  | { kind: 'conflict' }
  | { kind: 'legacy_unverifiable'; storedResponse: Record<string, unknown> };

/**
 * Interprets an already stored key for this request. Returns undefined when
 * no accepted row exists (i.e. this is a new submission). Used both before
 * the first write and after a batch collision, so concurrent callers apply
 * the exact same replay/conflict/legacy rules.
 */
export const outcomeForStoredIntakeKey = (
  stored: StoredIntakeKey | null,
  requestHash: string,
): IntakePersistenceOutcome | undefined => {
  switch (checkStoredIntakeKey(stored, requestHash)) {
    case 'replay':
      return {
        kind: 'replayed',
        response: stored!.responseJson as unknown as IntakeResponse,
      };
    case 'legacy_unverifiable':
      return { kind: 'legacy_unverifiable', storedResponse: stored!.responseJson };
    case 'conflict':
      return { kind: 'conflict' };
    default:
      return undefined;
  }
};

export const createIntakeAtomically = async (
  env: Env,
  input: IntakeInput,
  contactValues: CustomFieldWrite[],
  opportunityValues: CustomFieldWrite[],
  idempotencyKey: string,
  requestHash: string,
): Promise<IntakePersistenceOutcome> => {
  const timestamp = now();
  const opportunityId = id();
  const activityId = id();
  const email = normalizeEmail(input.contact.email);
  const pipelineId = intakePipelineId(input);
  const stageId = intakeStageId(input);
  const response = { created: true, opportunityId };
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `INSERT INTO contacts (id, workspace_id, email, normalized_email, first_name, last_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, normalized_email) DO UPDATE SET
           email = excluded.email,
           first_name = COALESCE(excluded.first_name, contacts.first_name),
           last_name = COALESCE(excluded.last_name, contacts.last_name),
           updated_at = excluded.updated_at`,
      )
      .bind(
        id(),
        DEFAULT_WORKSPACE_ID,
        email,
        email,
        input.contact.firstName ?? null,
        input.contact.lastName ?? null,
        timestamp,
        timestamp,
      ),
    env.DB
      .prepare(
        `INSERT INTO opportunities (
          id, workspace_id, primary_contact_id, pipeline_id, stage_id, name, source, estimated_value, created_at, updated_at
        ) SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?
          FROM contacts WHERE workspace_id = ? AND normalized_email = ?`,
      )
      .bind(
        opportunityId,
        DEFAULT_WORKSPACE_ID,
        pipelineId,
        stageId,
        input.opportunity.name,
        input.opportunity.source,
        input.opportunity.estimatedValue ?? null,
        timestamp,
        timestamp,
        DEFAULT_WORKSPACE_ID,
        email,
      ),
    env.DB
      .prepare(
        `INSERT INTO activities (
          id, workspace_id, contact_id, opportunity_id, kind, body, metadata, created_at
        ) SELECT ?, ?, id, ?, ?, ?, ?, ?
          FROM contacts WHERE workspace_id = ? AND normalized_email = ?`,
      )
      .bind(
        activityId,
        DEFAULT_WORKSPACE_ID,
        opportunityId,
        'intake',
        `Received from ${input.source}`,
        JSON.stringify({ source: input.source }),
        timestamp,
        DEFAULT_WORKSPACE_ID,
        email,
      ),
  ];

  // Intake is a creation: explicit nulls for optional fields are omitted by
  // validation, so only `set` writes reach persistence here.
  for (const value of contactValues) {
    if (value.kind !== 'set') continue;
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO custom_field_values (
            id, workspace_id, entity_type, entity_id, field_definition_id,
            value_text, value_number, value_boolean, value_date, created_at, updated_at
          ) SELECT ?, ?, 'contact', id, ?, ?, ?, ?, ?, ?, ?
          FROM contacts WHERE workspace_id = ? AND normalized_email = ?
          ON CONFLICT(entity_type, entity_id, field_definition_id) DO UPDATE SET
            value_text = excluded.value_text, value_number = excluded.value_number,
            value_boolean = excluded.value_boolean, value_date = excluded.value_date,
            updated_at = excluded.updated_at`,
        )
        .bind(
          id(),
          DEFAULT_WORKSPACE_ID,
          value.fieldId,
          value.valueText,
          value.valueNumber,
          value.valueBoolean,
          value.valueDate,
          timestamp,
          timestamp,
          DEFAULT_WORKSPACE_ID,
          email,
        ),
    );
  }
  for (const value of opportunityValues) {
    if (value.kind !== 'set') continue;
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO custom_field_values (
            id, workspace_id, entity_type, entity_id, field_definition_id,
            value_text, value_number, value_boolean, value_date, created_at, updated_at
          ) VALUES (?, ?, 'opportunity', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_type, entity_id, field_definition_id) DO UPDATE SET
            value_text = excluded.value_text, value_number = excluded.value_number,
            value_boolean = excluded.value_boolean, value_date = excluded.value_date,
            updated_at = excluded.updated_at`,
        )
        .bind(
          id(),
          DEFAULT_WORKSPACE_ID,
          opportunityId,
          value.fieldId,
          value.valueText,
          value.valueNumber,
          value.valueBoolean,
          value.valueDate,
          timestamp,
          timestamp,
        ),
    );
  }
  // The accepted key (with its fingerprint) commits in the same atomic batch
  // as the domain writes: a failed batch rolls the key back as well, so a
  // transient failure never reserves the key and the retry can still succeed.
  statements.push(
    env.DB
      .prepare(
        'INSERT INTO idempotency_keys (workspace_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(DEFAULT_WORKSPACE_ID, idempotencyKey, requestHash, JSON.stringify(response), timestamp),
  );

  try {
    await env.DB.batch(statements);
    return { kind: 'created', response };
  } catch (error) {
    // A unique-key collision means a concurrent request already committed
    // this key; any other failure committed nothing. Re-read and apply the
    // SAME fingerprint/legacy rules as the fast path — never an
    // unconditional replay — then surface the original error if no accepted
    // row exists.
    const stored = await getIntakeKey(env, idempotencyKey);
    const outcome = outcomeForStoredIntakeKey(stored, requestHash);
    if (outcome) return outcome;
    throw error;
  }
};

const hashToken = async (token: string): Promise<string> => {
  const source = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(hash))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
};
