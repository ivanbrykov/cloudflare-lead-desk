import { Either, Schema } from 'effect';
import type { CustomFieldValues, FieldEntity, FieldType } from './schemas';
import { DomainError } from '@/application/errors';

export interface FieldDefinition {
  id: string;
  key: string;
  options: string[];
  required: boolean;
  type: FieldType;
}

export interface NormalizedFieldValue {
  fieldId: string;
  valueBoolean: number | null;
  valueDate: string | null;
  valueNumber: number | null;
  valueText: string | null;
}

const schemaFor = (definition: FieldDefinition): Schema.Schema.Any => {
  switch (definition.type) {
    case 'boolean':
      return Schema.Boolean;
    case 'date':
      return Schema.String.pipe(
        Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
      );
    case 'number':
      return Schema.Number.pipe(Schema.finite());
    case 'select':
      return Schema.String.pipe(
        Schema.filter((value) => definition.options.includes(value), {
          message: () => `must be one of: ${definition.options.join(', ')}`,
        }),
      );
    case 'text':
      return Schema.String.pipe(Schema.trimmed(), Schema.minLength(1));
  }
};

const normalize = (
  definition: FieldDefinition,
  value: unknown,
): NormalizedFieldValue => {
  const decoded = Schema.decodeUnknownEither(schemaFor(definition) as Schema.Schema<unknown, unknown, never>)(value);
  if (Either.isLeft(decoded)) {
    throw new DomainError({
      code: 'invalid_custom_field',
      details: {
        field: definition.key,
        issue: decoded.left.message,
      },
      message: `Invalid value for custom field “${definition.key}”.`,
    });
  }

  const normalized = decoded.right;
  return {
    fieldId: definition.id,
    valueBoolean: definition.type === 'boolean' ? Number(normalized) : null,
    valueDate: definition.type === 'date' ? String(normalized) : null,
    valueNumber: definition.type === 'number' ? Number(normalized) : null,
    valueText:
      definition.type === 'text' || definition.type === 'select'
        ? String(normalized)
        : null,
  };
};

export const validateCustomFields = (
  entityType: FieldEntity,
  definitions: FieldDefinition[],
  values: CustomFieldValues | undefined,
): NormalizedFieldValue[] => {
  const provided = values ?? {};
  const definitionByKey = new Map(definitions.map((field) => [field.key, field]));

  for (const key of Object.keys(provided)) {
    if (!definitionByKey.has(key)) {
      throw new DomainError({
        code: 'unknown_custom_field',
        details: { entityType, field: key },
        message: `“${key}” is not an active ${entityType} field.`,
      });
    }
  }

  return definitions.flatMap((definition) => {
    const value = provided[definition.key];
    if (value === undefined) {
      if (definition.required) {
        throw new DomainError({
          code: 'missing_custom_field',
          details: { entityType, field: definition.key },
          message: `“${definition.key}” is required.`,
        });
      }
      return [];
    }
    return [normalize(definition, value)];
  });
};
