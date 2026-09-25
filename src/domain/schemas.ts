import { Schema } from 'effect';

const NonEmptyString = Schema.String.pipe(
  Schema.trimmed(),
  Schema.minLength(1),
);

export const Email = NonEmptyString.pipe(
  Schema.pattern(/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/u),
).annotations({ description: 'A valid email address.' });

export const RecordId = Schema.String.pipe(
  Schema.pattern(/[0-7][\dA-HJKMNP-TV-Z]{25}/u),
  Schema.filter((value) => value.length === 26),
).annotations({ description: 'A ULID record identifier.' });

// These primitives keep the `Schema` suffix: their derived types own the plain
// names (`FieldEntity`, `FieldType`, `CustomFieldValues`), and a value and type
// cannot share a name under @typescript-eslint/no-redeclare.
export const FieldEntitySchema = Schema.Literal('contact', 'opportunity');
export type FieldEntity = Schema.Schema.Type<typeof FieldEntitySchema>;

export const FieldTypeSchema = Schema.Literal(
  'text',
  'number',
  'boolean',
  'date',
  'select',
);
export type FieldType = Schema.Schema.Type<typeof FieldTypeSchema>;

export const CustomFieldValuesSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type CustomFieldValues = Schema.Schema.Type<
  typeof CustomFieldValuesSchema
>;

export const ContactInputRequest = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  email: Schema.optional(Email),
  firstName: Schema.optional(NonEmptyString),
  lastName: Schema.optional(NonEmptyString),
});
export type ContactInput = Schema.Schema.Type<typeof ContactInputRequest>;

export const OpportunityInputRequest = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  estimatedValue: Schema.optional(
    Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  ),
  name: NonEmptyString,
  pipelineId: Schema.optional(RecordId),
  source: Schema.optional(NonEmptyString),
  stageId: Schema.optional(RecordId),
});
export type OpportunityInput = Schema.Schema.Type<
  typeof OpportunityInputRequest
>;

export const CreateOpportunityRequest = Schema.Struct({
  contact: Schema.optional(ContactInputRequest),
  contactId: Schema.optional(RecordId),
  customFields: Schema.optional(CustomFieldValuesSchema),
  estimatedValue: Schema.optional(
    Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  ),
  name: NonEmptyString,
  pipelineId: Schema.optional(RecordId),
  source: Schema.optional(NonEmptyString),
  stageId: Schema.optional(RecordId),
});
export type CreateOpportunityInput = Schema.Schema.Type<
  typeof CreateOpportunityRequest
>;

export const IntakeRequest = Schema.Struct({
  contact: Schema.Struct({
    customFields: Schema.optional(CustomFieldValuesSchema),
    email: Email,
    firstName: Schema.optional(NonEmptyString),
    lastName: Schema.optional(NonEmptyString),
  }),
  opportunity: Schema.Struct({
    customFields: Schema.optional(CustomFieldValuesSchema),
    estimatedValue: Schema.optional(
      Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
    ),
    name: NonEmptyString,
    pipelineId: Schema.optional(RecordId),
    source: NonEmptyString,
    stageId: Schema.optional(RecordId),
  }),
  source: NonEmptyString,
});
export type IntakeInput = Schema.Schema.Type<typeof IntakeRequest>;

export const CreatePipelineRequest = Schema.Struct({
  name: NonEmptyString,
});

export const CreateStageRequest = Schema.Struct({
  color: Schema.optional(NonEmptyString),
  name: NonEmptyString,
  position: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
});

// Response contracts. Values are named `...Response` — the import site already
// says it is a schema, so the suffix names the role instead. Derived types keep
// plain descriptive names. Response values are in-process objects, so
// timestamps are Date instances (`Schema.DateFromSelf`), not the ISO strings
// the client receives.
export const HealthResponse = Schema.Struct({ ok: Schema.Boolean });

export const StageViewResponse = Schema.Struct({
  color: Schema.String,
  createdAt: Schema.DateFromSelf,
  id: Schema.String,
  name: Schema.String,
  pipelineId: Schema.String,
  position: Schema.Number,
  updatedAt: Schema.DateFromSelf,
  workspaceId: Schema.String,
});

export const PipelineViewResponse = Schema.Struct({
  archivedAt: Schema.NullOr(Schema.DateFromSelf),
  createdAt: Schema.DateFromSelf,
  id: Schema.String,
  name: Schema.String,
  stages: Schema.Array(StageViewResponse),
  updatedAt: Schema.DateFromSelf,
  workspaceId: Schema.String,
});

export const PipelinesResponse = Schema.Struct({
  data: Schema.Array(PipelineViewResponse),
});
export type PipelineView = Schema.Schema.Type<typeof PipelineViewResponse>;
export type StageView = Schema.Schema.Type<typeof StageViewResponse>;

export const MoveOpportunityRequest = Schema.Struct({
  stageId: RecordId,
});

export const UpdateOpportunityRequest = Schema.Struct({
  estimatedValue: Schema.optional(
    Schema.NullOr(Schema.Number.pipe(Schema.finite(), Schema.nonNegative())),
  ),
  name: Schema.optional(NonEmptyString),
}).pipe(
  Schema.filter(
    (value) => value.name !== undefined || value.estimatedValue !== undefined,
  ),
);
export type UpdateOpportunityInput = Schema.Schema.Type<
  typeof UpdateOpportunityRequest
>;

export const CreateActivityRequest = Schema.Struct({
  body: NonEmptyString,
  kind: Schema.optional(Schema.Literal('note', 'contact_attempt')),
});

export const CreateCustomFieldRequest = Schema.Struct({
  entityType: FieldEntitySchema,
  key: NonEmptyString.pipe(Schema.pattern(/^[a-z][\d_a-z]*$/u)),
  label: NonEmptyString,
  options: Schema.optional(Schema.Array(NonEmptyString)),
  required: Schema.optional(Schema.Boolean),
  type: FieldTypeSchema,
});
export type CreateCustomField = Schema.Schema.Type<
  typeof CreateCustomFieldRequest
>;

// A future UTC ISO-8601 date (optional time, offset, or Z) for expiry
// overrides on API tokens and staff invitations.
const FutureIsoDate = Schema.String.pipe(
  Schema.pattern(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u,
  ),

  Schema.filter((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time > Date.now();
  }),
);

export const CreateTokenRequest = Schema.Struct({
  expiresAt: Schema.optional(FutureIsoDate),
  name: NonEmptyString,
}).annotations({
  description: 'Creates an intake token (90 days by default).',
});

export const CreateInviteRequest = Schema.Struct({
  expiresAt: Schema.optional(FutureIsoDate),
  name: NonEmptyString,
}).annotations({
  description: 'Creates a single-use staff invitation (7 days by default).',
});
export type CreateInviteInput = Schema.Schema.Type<typeof CreateInviteRequest>;

export const ValidateInviteRequest = Schema.Struct({
  token: Schema.String,
}).annotations({
  description:
    'Checks a registration grant without consuming it. Any token is an input; only 200 vs 403 differ.',
});
export type ValidateInviteInput = Schema.Schema.Type<
  typeof ValidateInviteRequest
>;

export const SetStaffDisabledRequest = Schema.Struct({
  disabled: Schema.Boolean,
}).annotations({
  description:
    'Enables or disables a staff account. Disabling also revokes every session of that account; re-enabling preserves the credentials but never restores old sessions.',
});
export type SetStaffDisabledInput = Schema.Schema.Type<
  typeof SetStaffDisabledRequest
>;

export const Pagination = Schema.Struct({
  cursor: Schema.optional(RecordId),
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  ),
  query: Schema.optional(NonEmptyString),
});

export const ApiErrorResponse = Schema.Struct({
  code: NonEmptyString,
  details: Schema.optional(Schema.Unknown),
  message: NonEmptyString,
});

export type ApiError = Schema.Schema.Type<typeof ApiErrorResponse>;

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();
