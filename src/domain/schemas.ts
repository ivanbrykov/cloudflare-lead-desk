import { Schema } from 'effect';

const NonEmptyString = Schema.String.pipe(
  Schema.trimmed(),
  Schema.minLength(1),
);

export const EmailSchema = NonEmptyString.pipe(
  Schema.pattern(/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/u),
).annotations({ description: 'A valid email address.' });

export const RecordIdSchema = Schema.String.pipe(
  Schema.pattern(/[0-7][\dA-HJKMNP-TV-Z]{25}/u),
  Schema.filter((value) => value.length === 26),
).annotations({ description: 'A ULID record identifier.' });

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

export const ContactInputSchema = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  email: Schema.optional(EmailSchema),
  firstName: Schema.optional(NonEmptyString),
  lastName: Schema.optional(NonEmptyString),
});
export type ContactInput = Schema.Schema.Type<typeof ContactInputSchema>;

export const OpportunityInputSchema = Schema.Struct({
  customFields: Schema.optional(CustomFieldValuesSchema),
  estimatedValue: Schema.optional(
    Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  ),
  name: NonEmptyString,
  pipelineId: Schema.optional(RecordIdSchema),
  source: Schema.optional(NonEmptyString),
  stageId: Schema.optional(RecordIdSchema),
});
export type OpportunityInput = Schema.Schema.Type<
  typeof OpportunityInputSchema
>;

export const CreateOpportunitySchema = Schema.Struct({
  contact: Schema.optional(ContactInputSchema),
  contactId: Schema.optional(RecordIdSchema),
  customFields: Schema.optional(CustomFieldValuesSchema),
  estimatedValue: Schema.optional(
    Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  ),
  name: NonEmptyString,
  pipelineId: Schema.optional(RecordIdSchema),
  source: Schema.optional(NonEmptyString),
  stageId: Schema.optional(RecordIdSchema),
});
export type CreateOpportunityInput = Schema.Schema.Type<
  typeof CreateOpportunitySchema
>;

export const IntakeInputSchema = Schema.Struct({
  contact: Schema.Struct({
    customFields: Schema.optional(CustomFieldValuesSchema),
    email: EmailSchema,
    firstName: Schema.optional(NonEmptyString),
    lastName: Schema.optional(NonEmptyString),
  }),
  opportunity: Schema.Struct({
    customFields: Schema.optional(CustomFieldValuesSchema),
    estimatedValue: Schema.optional(
      Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
    ),
    name: NonEmptyString,
    pipelineId: Schema.optional(RecordIdSchema),
    source: NonEmptyString,
    stageId: Schema.optional(RecordIdSchema),
  }),
  source: NonEmptyString,
});
export type IntakeInput = Schema.Schema.Type<typeof IntakeInputSchema>;

export const CreatePipelineSchema = Schema.Struct({
  name: NonEmptyString,
});

export const CreateStageSchema = Schema.Struct({
  color: Schema.optional(NonEmptyString),
  name: NonEmptyString,
  position: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
});

export const MoveOpportunitySchema = Schema.Struct({
  stageId: RecordIdSchema,
});

export const UpdateOpportunitySchema = Schema.Struct({
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
  typeof UpdateOpportunitySchema
>;

export const CreateActivitySchema = Schema.Struct({
  body: NonEmptyString,
  kind: Schema.optional(Schema.Literal('note', 'contact_attempt')),
});

export const CreateCustomFieldSchema = Schema.Struct({
  entityType: FieldEntitySchema,
  key: NonEmptyString.pipe(Schema.pattern(/^[a-z][\d_a-z]*$/u)),
  label: NonEmptyString,
  options: Schema.optional(Schema.Array(NonEmptyString)),
  required: Schema.optional(Schema.Boolean),
  type: FieldTypeSchema,
});
export type CreateCustomField = Schema.Schema.Type<
  typeof CreateCustomFieldSchema
>;

// A future UTC ISO-8601 date (optional time, offset, or Z) for expiry
// overrides on API tokens and staff invitations.
const FutureIsoDateSchema = Schema.String.pipe(
  Schema.pattern(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u,
  ),

  Schema.filter((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time > Date.now();
  }),
);

export const CreateTokenSchema = Schema.Struct({
  expiresAt: Schema.optional(FutureIsoDateSchema),
  name: NonEmptyString,
}).annotations({
  description: 'Creates an intake token (90 days by default).',
});

export const CreateInviteSchema = Schema.Struct({
  expiresAt: Schema.optional(FutureIsoDateSchema),
  name: NonEmptyString,
}).annotations({
  description: 'Creates a single-use staff invitation (7 days by default).',
});
export type CreateInviteInput = Schema.Schema.Type<typeof CreateInviteSchema>;

export const ValidateInviteSchema = Schema.Struct({
  token: Schema.String,
}).annotations({
  description:
    'Checks a registration grant without consuming it. Any token is an input; only 200 vs 403 differ.',
});
export type ValidateInviteInput = Schema.Schema.Type<
  typeof ValidateInviteSchema
>;

export const SetStaffDisabledSchema = Schema.Struct({
  disabled: Schema.Boolean,
}).annotations({
  description:
    'Enables or disables a staff account. Disabling also revokes every session of that account; re-enabling preserves the credentials but never restores old sessions.',
});
export type SetStaffDisabledInput = Schema.Schema.Type<
  typeof SetStaffDisabledSchema
>;

export const PaginationSchema = Schema.Struct({
  cursor: Schema.optional(RecordIdSchema),
  limit: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  ),
  query: Schema.optional(NonEmptyString),
});

export const ApiErrorSchema = Schema.Struct({
  code: NonEmptyString,
  details: Schema.optional(Schema.Unknown),
  message: NonEmptyString,
});

export type ApiError = Schema.Schema.Type<typeof ApiErrorSchema>;

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();
