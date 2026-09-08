import { Schema } from 'effect';

const NonEmptyString = Schema.String.pipe(
  Schema.trimmed(),
  Schema.minLength(1),
);

export const EmailSchema = NonEmptyString.pipe(
  Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
).annotations({ description: 'A valid email address.' });

export const RecordIdSchema = Schema.String.pipe(
  Schema.pattern(/[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}/),
  Schema.filter((value) => value.length === 26, {
    message: () => "must be a 26-character ULID",
  }),
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
  email: Schema.optional(EmailSchema),
  firstName: Schema.optional(NonEmptyString),
  lastName: Schema.optional(NonEmptyString),
  customFields: Schema.optional(CustomFieldValuesSchema),
});
export type ContactInput = Schema.Schema.Type<typeof ContactInputSchema>;

export const OpportunityInputSchema = Schema.Struct({
  estimatedValue: Schema.optional(
    Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  ),
  name: NonEmptyString,
  pipelineId: Schema.optional(RecordIdSchema),
  source: Schema.optional(NonEmptyString),
  stageId: Schema.optional(RecordIdSchema),
  customFields: Schema.optional(CustomFieldValuesSchema),
});
export type OpportunityInput = Schema.Schema.Type<
  typeof OpportunityInputSchema
>;

export const CreateOpportunitySchema = Schema.Struct({
  contact: Schema.optional(ContactInputSchema),
  contactId: Schema.optional(RecordIdSchema),
  estimatedValue: Schema.optional(
    Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  ),
  name: NonEmptyString,
  pipelineId: Schema.optional(RecordIdSchema),
  source: Schema.optional(NonEmptyString),
  stageId: Schema.optional(RecordIdSchema),
  customFields: Schema.optional(CustomFieldValuesSchema),
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

export const CreateActivitySchema = Schema.Struct({
  body: NonEmptyString,
  kind: Schema.optional(Schema.Literal('note', 'contact_attempt')),
});

export const CreateCustomFieldSchema = Schema.Struct({
  entityType: FieldEntitySchema,
  key: NonEmptyString.pipe(Schema.pattern(/^[a-z][a-z0-9_]*$/)),
  label: NonEmptyString,
  options: Schema.optional(Schema.Array(NonEmptyString)),
  required: Schema.optional(Schema.Boolean),
  type: FieldTypeSchema,
});
export type CreateCustomField = Schema.Schema.Type<
  typeof CreateCustomFieldSchema
>;

export const CreateTokenSchema = Schema.Struct({
  name: NonEmptyString,
});

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

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
