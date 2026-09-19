import {
  activities,
  apiTokens,
  bootstrapState,
  contacts,
  customFieldDefinitions,
  customFieldValues,
  idempotencyKeys,
  opportunities,
  pipelines,
  session,
  staffInvites,
  stages,
  user,
} from './schema';
import { type RegistrationGrant } from '@/auth/registration-repository';
import {
  type CustomFieldWrite,
  type NormalizedFieldValue,
} from '@/domain/custom-fields';
import { type IntakeResponse } from '@/domain/intake';
import { type ContactKeyset, encodeContactCursor } from '@/domain/pagination';
import {
  type ContactInput,
  type CreateCustomField,
  type CreateOpportunityInput,
  type FieldEntity,
  type IntakeInput,
  normalizeEmail,
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

const now = (): string => new Date().toISOString();
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

export type ContactRecord = {
  createdAt: string;
  email: null | string;
  firstName: null | string;
  id: string;
  lastName: null | string;
  updatedAt: string;
};

export type FieldDefinitionRecord = {
  archivedAt: null | string;
  entityType: FieldEntity;
  id: string;
  key: string;
  label: string;
  options: string[];
  required: boolean;
  type: 'boolean' | 'date' | 'number' | 'select' | 'text';
};

export type OpportunityRecord = {
  contact: ContactRecord;
  createdAt: string;
  estimatedValue: null | number;
  id: string;
  name: string;
  pipelineId: string;
  source: string;
  stageId: string;
  updatedAt: string;
};

const getDatabase = (environment: Env) => drizzle(environment.DB);

export const getFieldDefinitions = async (
  environment: Env,
  entityType: FieldEntity,
  includeArchived = false,
): Promise<FieldDefinitionRecord[]> => {
  const database = getDatabase(environment);
  const predicates = [
    eq(customFieldDefinitions.workspaceId, DEFAULT_WORKSPACE_ID),
    eq(customFieldDefinitions.entityType, entityType),
  ];
  if (!includeArchived) {
    predicates.push(isNull(customFieldDefinitions.archivedAt));
  }

  const rows = await database
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
const decodeFieldValue = (row: {
  type: string;
  valueBoolean: null | number;
  valueDate: null | string;
  valueNumber: null | number;
  valueText: null | string;
}): unknown =>
  // Boolean fields are stored as 0/1 in SQLite; decode by definition type
  // so false round-trips as a real JSON boolean.
  row.type === 'boolean'
    ? Boolean(row.valueBoolean)
    : row.type === 'number'
      ? row.valueNumber
      : row.type === 'date'
        ? row.valueDate
        : row.valueText;

/**
 * D1 binds at most 100 parameters per statement. Each chunked field query
 * binds the entity type once plus one parameter per entity id, so ids per
 * chunk stay under that budget (99 ids + 1 type = 100 bindings).
 */
const FIELD_VALUE_CHUNK_SIZE = 99;

const escapeLike = (value: string) =>
  value.replaceAll('%', '\\%').replaceAll('_', '\\_');

/**
 * Literal substring match on first name, last name, or email; `%` and `_`
 * in the query are escaped so they never act as LIKE wildcards.
 */
const contactSearchPredicate = (query: string) => {
  const pattern = `%${escapeLike(query)}%`;
  return sql`(${contacts.firstName} LIKE ${pattern} ESCAPE '\\' OR ${contacts.lastName} LIKE ${pattern} ESCAPE '\\' OR ${contacts.email} LIKE ${pattern} ESCAPE '\\')`;
};

/**
 * Batched replacement for the per-record field query: fetches custom-field
 * values for every requested entity id in chunked IN (...) queries against
 * the active definitions, with the same decode rules as single-entity
 * reads. List endpoints call this once per page instead of once per row.
 */
export const valuesForEntities = async (
  environment: Env,
  entityType: FieldEntity,
  entityIds: string[],
): Promise<Map<string, Record<string, unknown>>> => {
  const byEntity = new Map<string, Record<string, unknown>>();
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) {
    return byEntity;
  }

  const database = getDatabase(environment);
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += FIELD_VALUE_CHUNK_SIZE) {
    chunks.push(ids.slice(offset, offset + FIELD_VALUE_CHUNK_SIZE));
  }

  const pages = await Promise.all(
    chunks.map((chunk) =>
      database
        .select({
          entityId: customFieldValues.entityId,
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
            inArray(customFieldValues.entityId, chunk),
            isNull(customFieldDefinitions.archivedAt),
          ),
        ),
    ),
  );
  for (const rows of pages) {
    for (const row of rows) {
      const record = byEntity.get(row.entityId) ?? {};
      record[row.key] = decodeFieldValue(row);
      byEntity.set(row.entityId, record);
    }
  }

  return byEntity;
};

const valuesForEntity = async (
  environment: Env,
  entityType: FieldEntity,
  entityId: string,
): Promise<Record<string, unknown>> =>
  (await valuesForEntities(environment, entityType, [entityId])).get(
    entityId,
  ) ?? {};

const upsertFieldValue = (
  environment: Env,
  entityType: FieldEntity,
  entityId: string,
  value: NormalizedFieldValue,
  timestamp: string,
): D1PreparedStatement =>
  environment.DB.prepare(
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
  ).bind(
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
  environment: Env,
  entityType: FieldEntity,
  entityId: string,
  fieldId: string,
): D1PreparedStatement =>
  environment.DB.prepare(
    'DELETE FROM custom_field_values WHERE entity_type = ? AND entity_id = ? AND field_definition_id = ? AND workspace_id = ?',
  ).bind(entityType, entityId, fieldId, DEFAULT_WORKSPACE_ID);

const fieldWriteStatements = (
  environment: Env,
  entityType: FieldEntity,
  entityId: string,
  writes: CustomFieldWrite[],
  timestamp: string,
): D1PreparedStatement[] =>
  writes.flatMap((write) =>
    write.kind === 'set'
      ? [upsertFieldValue(environment, entityType, entityId, write, timestamp)]
      : [deleteFieldValue(environment, entityType, entityId, write.fieldId)],
  );

export type ContactPage = {
  contacts: Array<ContactRecord & { customFields: Record<string, unknown> }>;
  nextCursor: null | string;
};

export type ContactPageOptions = {
  cursor?: ContactKeyset | null;
  limit: number;
  query?: string;
};

/**
 * Keyset (seek) pagination over (created_at DESC, id DESC). `cursor` is the
 * decoded position of the last row of the previous page; the page window is
 * the rows strictly after that position, bounded by `limit`. One extra row
 * is fetched to detect a following page without a COUNT query.
 */
const toContact = (row: typeof contacts.$inferSelect): ContactRecord => ({
  createdAt: row.createdAt,
  email: row.email,
  firstName: row.firstName,
  id: row.id,
  lastName: row.lastName,
  updatedAt: row.updatedAt,
});

export const listContacts = async (
  environment: Env,
  options: ContactPageOptions,
): Promise<ContactPage> => {
  const { cursor, limit, query } = options;
  const database = getDatabase(environment);
  const predicates = [eq(contacts.workspaceId, DEFAULT_WORKSPACE_ID)];
  if (query) {
    predicates.push(contactSearchPredicate(query));
  }

  if (cursor) {
    predicates.push(
      sql`(${contacts.createdAt} < ${cursor.createdAt} OR (${contacts.createdAt} = ${cursor.createdAt} AND ${contacts.id} < ${cursor.id}))`,
    );
  }

  const rows = await database
    .select()
    .from(contacts)
    .where(and(...predicates))
    .orderBy(desc(contacts.createdAt), desc(contacts.id))
    .limit(limit + 1);
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const values = await valuesForEntities(
    environment,
    'contact',
    pageRows.map((row) => row.id),
  );
  const contactsPage = pageRows.map((row) => ({
    ...toContact(row),
    customFields: values.get(row.id) ?? {},
  }));
  const last = pageRows[pageRows.length - 1];
  return {
    contacts: contactsPage,
    nextCursor:
      hasNextPage && last
        ? encodeContactCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
};

export const getContact = async (
  environment: Env,
  contactId: string,
): Promise<
  (ContactRecord & { customFields: Record<string, unknown> }) | null
> => {
  const database = getDatabase(environment);
  const row = await database
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
    ? {
        ...toContact(row),
        customFields: await valuesForEntity(environment, 'contact', row.id),
      }
    : null;
};

export const createContact = async (
  environment: Env,
  input: ContactInput,
  customFields: CustomFieldWrite[],
): Promise<ContactRecord & { customFields: Record<string, unknown> }> => {
  const timestamp = now();
  const contactId = id();
  const email = input.email ? normalizeEmail(input.email) : null;
  // Core contact and custom-field values commit as one D1 batch, so a failed
  // field write rolls back the whole create instead of orphaning a contact.
  const statements: D1PreparedStatement[] = [
    environment.DB.prepare(
      'INSERT INTO contacts (id, workspace_id, email, normalized_email, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      contactId,
      DEFAULT_WORKSPACE_ID,
      email,
      email,
      input.firstName ?? null,
      input.lastName ?? null,
      timestamp,
      timestamp,
    ),
    ...fieldWriteStatements(
      environment,
      'contact',
      contactId,
      customFields,
      timestamp,
    ),
  ];
  await environment.DB.batch(statements);
  return {
    createdAt: timestamp,
    customFields: await valuesForEntity(environment, 'contact', contactId),
    email,
    firstName: input.firstName ?? null,
    id: contactId,
    lastName: input.lastName ?? null,
    updatedAt: timestamp,
  };
};

export const updateContact = async (
  environment: Env,
  contactId: string,
  input: ContactInput,
  customFields: CustomFieldWrite[],
): Promise<
  (ContactRecord & { customFields: Record<string, unknown> }) | null
> => {
  const existing = await getContact(environment, contactId);
  if (!existing) {
    return null;
  }

  const timestamp = now();
  const email = input.email ? normalizeEmail(input.email) : null;
  // The core update and every field set/clear share one D1 batch, so a
  // failed field write leaves the contact (including updatedAt) unchanged.
  const statements: D1PreparedStatement[] = [
    environment.DB.prepare(
      'UPDATE contacts SET email = ?, first_name = ?, last_name = ?, normalized_email = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    ).bind(
      email,
      input.firstName ?? null,
      input.lastName ?? null,
      email,
      timestamp,
      contactId,
      DEFAULT_WORKSPACE_ID,
    ),
    ...fieldWriteStatements(
      environment,
      'contact',
      contactId,
      customFields,
      timestamp,
    ),
  ];
  await environment.DB.batch(statements);
  return getContact(environment, contactId);
};

export const deleteContact = async (
  environment: Env,
  contactId: string,
): Promise<'deleted' | 'has_opportunities' | 'not_found'> => {
  const database = getDatabase(environment);
  const existing = await getContact(environment, contactId);
  if (!existing) {
    return 'not_found';
  }

  const linkedOpportunity = await database
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.primaryContactId, contactId),
        eq(opportunities.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .get();
  if (linkedOpportunity) {
    return 'has_opportunities';
  }

  await database
    .delete(customFieldValues)
    .where(
      and(
        eq(customFieldValues.entityType, 'contact'),
        eq(customFieldValues.entityId, contactId),
        eq(customFieldValues.workspaceId, DEFAULT_WORKSPACE_ID),
      ),
    )
    .run();
  await database
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
// routing: a submission without explicit pipeline/stage uses the default
// pipeline and stage bootstrapped by the schema migration.
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

export const getOpportunity = async (
  environment: Env,
  opportunityId: string,
): Promise<
  null | (OpportunityRecord & { customFields: Record<string, unknown> })
> => {
  const database = getDatabase(environment);
  const row = await database
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
  if (!row) {
    return null;
  }

  return {
    contact: toContact(row.contact),
    createdAt: row.opportunity.createdAt,
    customFields: await valuesForEntity(
      environment,
      'opportunity',
      row.opportunity.id,
    ),
    estimatedValue: row.opportunity.estimatedValue,
    id: row.opportunity.id,
    name: row.opportunity.name,
    pipelineId: row.opportunity.pipelineId,
    source: row.opportunity.source,
    stageId: row.opportunity.stageId,
    updatedAt: row.opportunity.updatedAt,
  };
};

export const createManualOpportunity = async (
  environment: Env,
  input: CreateOpportunityInput,
  contactValues: CustomFieldWrite[],
  opportunityValues: CustomFieldWrite[],
  actorEmail: string,
): Promise<
  | 'contact_not_found'
  | 'invalid_stage'
  | (OpportunityRecord & { customFields: Record<string, unknown> })
> => {
  if (input.contactId && !(await getContact(environment, input.contactId))) {
    return 'contact_not_found';
  }

  const pipelineId = input.pipelineId ?? DEFAULT_PIPELINE_ID;
  const stageId = input.stageId ?? DEFAULT_STAGE_ID;
  if (
    !(await isStageInActiveWorkspacePipeline(environment, pipelineId, stageId))
  ) {
    return 'invalid_stage';
  }

  const timestamp = now();
  const contactId = input.contactId ?? id();
  const opportunityId = id();
  const statements: D1PreparedStatement[] = [];
  if (input.contact) {
    const email = input.contact.email
      ? normalizeEmail(input.contact.email)
      : null;
    statements.push(
      environment.DB.prepare(
        'INSERT INTO contacts (id, workspace_id, email, normalized_email, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        contactId,
        DEFAULT_WORKSPACE_ID,
        email,
        email,
        input.contact.firstName ?? null,
        input.contact.lastName ?? null,
        timestamp,
        timestamp,
      ),
    );
  }

  statements.push(
    environment.DB.prepare(
      'INSERT INTO opportunities (id, workspace_id, primary_contact_id, pipeline_id, stage_id, name, source, estimated_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      opportunityId,
      DEFAULT_WORKSPACE_ID,
      contactId,
      pipelineId,
      stageId,
      input.name,
      input.source ?? 'manual',
      input.estimatedValue ?? null,
      timestamp,
      timestamp,
    ),
    environment.DB.prepare(
      'INSERT INTO activities (id, workspace_id, contact_id, opportunity_id, kind, body, actor_email, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      id(),
      DEFAULT_WORKSPACE_ID,
      contactId,
      opportunityId,
      'manual_entry',
      'Created manually',
      actorEmail,
      JSON.stringify({ source: input.source ?? 'manual' }),
      timestamp,
    ),
  );
  // A manual opportunity is a creation: clear writes are impossible, and the
  // field statements commit in the same batch as the new records.
  statements.push(
    ...fieldWriteStatements(
      environment,
      'contact',
      contactId,
      contactValues,
      timestamp,
    ),
    ...fieldWriteStatements(
      environment,
      'opportunity',
      opportunityId,
      opportunityValues,
      timestamp,
    ),
  );
  await environment.DB.batch(statements);
  const created = await getOpportunity(environment, opportunityId);
  if (created === null) {
    throw new Error(`Opportunity ${opportunityId} was not created`);
  }

  return created;
};

export const listOpportunities = async (
  environment: Env,
  pipelineId?: string,
): Promise<
  Array<OpportunityRecord & { customFields: Record<string, unknown> }>
> => {
  const database = getDatabase(environment);
  const predicates = [eq(opportunities.workspaceId, DEFAULT_WORKSPACE_ID)];
  if (pipelineId) {
    predicates.push(eq(opportunities.pipelineId, pipelineId));
  }

  const rows = await database
    .select({
      contact: contacts,
      opportunity: opportunities,
    })
    .from(opportunities)
    .innerJoin(contacts, eq(opportunities.primaryContactId, contacts.id))
    .where(and(...predicates))
    .orderBy(desc(opportunities.createdAt));

  const values = await valuesForEntities(
    environment,
    'opportunity',
    rows.map(({ opportunity }) => opportunity.id),
  );
  return rows.map(({ contact, opportunity }) => ({
    contact: toContact(contact),
    createdAt: opportunity.createdAt,
    customFields: values.get(opportunity.id) ?? {},
    estimatedValue: opportunity.estimatedValue,
    id: opportunity.id,
    name: opportunity.name,
    pipelineId: opportunity.pipelineId,
    source: opportunity.source,
    stageId: opportunity.stageId,
    updatedAt: opportunity.updatedAt,
  }));
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

export const moveOpportunity = async (
  environment: Env,
  opportunityId: string,
  stageId: string,
  actorEmail: string,
) => {
  const opportunity = await getOpportunity(environment, opportunityId);
  if (!opportunity) {
    return null;
  }

  const stage = await getDatabase(environment)
    .select()
    .from(stages)
    .where(
      and(
        eq(stages.id, stageId),
        eq(stages.pipelineId, opportunity.pipelineId),
      ),
    )
    .get();
  if (!stage) {
    return undefined;
  }

  const timestamp = now();
  await environment.DB.batch([
    environment.DB.prepare(
      'UPDATE opportunities SET stage_id = ?, updated_at = ? WHERE id = ?',
    ).bind(stageId, timestamp, opportunityId),
    environment.DB.prepare(
      'INSERT INTO activities (id, workspace_id, contact_id, opportunity_id, kind, body, actor_email, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
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
  return getOpportunity(environment, opportunityId);
};

export const updateOpportunity = async (
  environment: Env,
  opportunityId: string,
  input: { estimatedValue?: null | number; name?: string },
): Promise<
  null | (OpportunityRecord & { customFields: Record<string, unknown> })
> => {
  const existing = await getOpportunity(environment, opportunityId);
  if (!existing) {
    return null;
  }

  const timestamp = now();
  const name = input.name ?? existing.name;
  const estimatedValue =
    input.estimatedValue === undefined
      ? existing.estimatedValue
      : input.estimatedValue;
  await environment.DB.prepare(
    'UPDATE opportunities SET name = ?, estimated_value = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
  )
    .bind(name, estimatedValue, timestamp, opportunityId, DEFAULT_WORKSPACE_ID)
    .run();
  return getOpportunity(environment, opportunityId);
};

export const createActivity = async (
  environment: Env,
  opportunityId: string,
  actorEmail: string,
  kind: string,
  body: string,
) => {
  const opportunity = await getOpportunity(environment, opportunityId);
  if (!opportunity) {
    return null;
  }

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
  await getDatabase(environment).insert(activities).values(activity);
  return activity;
};

export const listActivities = async (environment: Env, opportunityId: string) =>
  getDatabase(environment)
    .select()
    .from(activities)
    .where(eq(activities.opportunityId, opportunityId))
    .orderBy(desc(activities.createdAt));

export const createFieldDefinition = async (
  environment: Env,
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
  await getDatabase(environment).insert(customFieldDefinitions).values(field);
  return field;
};

export const archiveFieldDefinition = async (
  environment: Env,
  fieldId: string,
) => {
  const timestamp = now();
  const result = await getDatabase(environment)
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
      expiresAt ?? new Date(Date.now() + TOKEN_DEFAULT_TTL_MS).toISOString(),
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
  createdAt: string;
  expiresAt: string;
  id: string;
  name: string;
  prefix: string;
  revokedAt: null | string;
  usedAt: null | string;
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
      expiresAt ?? new Date(Date.now() + INVITE_DEFAULT_TTL_MS).toISOString(),
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
    record.expiresAt <= now()
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
    bootstrap.expiresAt > now()
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

export const createIntakeAtomically = async (
  environment: Env,
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
    environment.DB.prepare(
      `INSERT INTO contacts (id, workspace_id, email, normalized_email, first_name, last_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, normalized_email) DO UPDATE SET
           email = excluded.email,
           first_name = COALESCE(excluded.first_name, contacts.first_name),
           last_name = COALESCE(excluded.last_name, contacts.last_name),
           updated_at = excluded.updated_at`,
    ).bind(
      id(),
      DEFAULT_WORKSPACE_ID,
      email,
      email,
      input.contact.firstName ?? null,
      input.contact.lastName ?? null,
      timestamp,
      timestamp,
    ),
    environment.DB.prepare(
      `INSERT INTO opportunities (
          id, workspace_id, primary_contact_id, pipeline_id, stage_id, name, source, estimated_value, created_at, updated_at
        ) SELECT ?, ?, id, ?, ?, ?, ?, ?, ?, ?
          FROM contacts WHERE workspace_id = ? AND normalized_email = ?`,
    ).bind(
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
    environment.DB.prepare(
      `INSERT INTO activities (
          id, workspace_id, contact_id, opportunity_id, kind, body, metadata, created_at
        ) SELECT ?, ?, id, ?, ?, ?, ?, ?
          FROM contacts WHERE workspace_id = ? AND normalized_email = ?`,
    ).bind(
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
    if (value.kind !== 'set') {
      continue;
    }

    statements.push(
      environment.DB.prepare(
        `INSERT INTO custom_field_values (
            id, workspace_id, entity_type, entity_id, field_definition_id,
            value_text, value_number, value_boolean, value_date, created_at, updated_at
          ) SELECT ?, ?, 'contact', id, ?, ?, ?, ?, ?, ?, ?
          FROM contacts WHERE workspace_id = ? AND normalized_email = ?
          ON CONFLICT(entity_type, entity_id, field_definition_id) DO UPDATE SET
            value_text = excluded.value_text, value_number = excluded.value_number,
            value_boolean = excluded.value_boolean, value_date = excluded.value_date,
            updated_at = excluded.updated_at`,
      ).bind(
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
    if (value.kind !== 'set') {
      continue;
    }

    statements.push(
      environment.DB.prepare(
        `INSERT INTO custom_field_values (
            id, workspace_id, entity_type, entity_id, field_definition_id,
            value_text, value_number, value_boolean, value_date, created_at, updated_at
          ) VALUES (?, ?, 'opportunity', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_type, entity_id, field_definition_id) DO UPDATE SET
            value_text = excluded.value_text, value_number = excluded.value_number,
            value_boolean = excluded.value_boolean, value_date = excluded.value_date,
            updated_at = excluded.updated_at`,
      ).bind(
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
    environment.DB.prepare(
      'INSERT INTO idempotency_keys (workspace_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(
      DEFAULT_WORKSPACE_ID,
      idempotencyKey,
      requestHash,
      JSON.stringify(response),
      timestamp,
    ),
  );

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
