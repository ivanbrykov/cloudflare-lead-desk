import { describe, expect, test } from 'vitest';
import { validateCustomFields } from '@/domain/custom-fields';

const cohortId = '00000000-0000-4000-8000-000000000010';
const childrenId = '00000000-0000-4000-8000-000000000011';
const consentId = '00000000-0000-4000-8000-000000000012';

const fields = [
  {
    id: cohortId,
    key: 'cohort',
    options: ['Fall', 'Spring'],
    required: true,
    type: 'select' as const,
  },
  {
    id: childrenId,
    key: 'children_count',
    options: [],
    required: false,
    type: 'number' as const,
  },
  {
    id: consentId,
    key: 'consent_given',
    options: [],
    required: false,
    type: 'boolean' as const,
  },
];

const setWrites = (entries: Record<string, unknown>) =>
  Object.entries(entries).map(([key, value]) => ({
    fieldId: fields.find((field) => field.key === key)?.id,
    kind: 'set' as const,
    valueBoolean: typeof value === 'boolean' ? Number(value) : null,
    valueDate: null,
    valueNumber: typeof value === 'number' ? value : null,
    valueText: typeof value === 'string' ? value : null,
  }));

describe('dynamic custom field validation', () => {
  test('normalizes an active field value into a typed persistence write', () => {
    expect(
      validateCustomFields('opportunity', fields, {
        children_count: 2,
        cohort: 'Fall',
      }),
    ).toEqual(setWrites({ cohort: 'Fall', children_count: 2 }));
  });

  test('normalizes boolean false as a real value, not a missing one', () => {
    expect(
      validateCustomFields('opportunity', fields, {
        cohort: 'Spring',
        consent_given: false,
      }),
    ).toEqual(
      setWrites({ cohort: 'Spring' }).concat([
        {
          fieldId: consentId,
          kind: 'set',
          valueBoolean: 0,
          valueDate: null,
          valueNumber: null,
          valueText: null,
        },
      ]),
    );
  });

  test('rejects unknown, missing, and invalid fields', () => {
    expect(() => validateCustomFields('opportunity', fields, { cohort: 'Summer' })).toThrow(
      'Invalid value',
    );
    expect(() => validateCustomFields('opportunity', fields, { children_count: 2 })).toThrow(
      'required',
    );
    expect(() => validateCustomFields('opportunity', fields, { cohort: 'Fall', unknown: true })).toThrow(
      'not an active',
    );
  });
});

describe('create mode rejects null for required fields', () => {
  test('null on a required field is rejected on creation', () => {
    expect(() =>
      validateCustomFields('contact', fields, { cohort: null, children_count: 1 }),
    ).toThrow('required and cannot be cleared');
  });

  test('null on an optional field is omitted, not persisted', () => {
    expect(
      validateCustomFields('contact', fields, { cohort: 'Fall', children_count: null }),
    ).toEqual(setWrites({ cohort: 'Fall' }));
  });
});

describe('update mode is PATCH-like', () => {
  test('explicit null clears an optional field', () => {
    expect(
      validateCustomFields(
        'contact',
        fields,
        { cohort: 'Fall', children_count: null },
        'update',
      ),
    ).toEqual([
      {
        fieldId: cohortId,
        kind: 'set',
        valueBoolean: null,
        valueDate: null,
        valueNumber: null,
        valueText: 'Fall',
      },
      { fieldId: childrenId, kind: 'clear' },
    ]);
  });

  test('omitting a required field preserves the stored value', () => {
    expect(
      validateCustomFields(
        'contact',
        fields,
        { children_count: 3 },
        'update',
        new Set(['cohort']),
      ),
    ).toEqual(setWrites({ children_count: 3 }));
  });

  test('a contact missing a required value cannot bypass validation', () => {
    expect(() =>
      validateCustomFields('contact', fields, { children_count: 3 }, 'update'),
    ).toThrow('required');
  });

  test('null on a required field is rejected even with a stored value', () => {
    expect(() =>
      validateCustomFields(
        'contact',
        fields,
        { cohort: null },
        'update',
        new Set(['cohort']),
      ),
    ).toThrow('required and cannot be cleared');
  });

  test('unknown keys are rejected in update mode too', () => {
    expect(() =>
      validateCustomFields(
        'contact',
        fields,
        { retired_key: 'x' },
        'update',
        new Set(['cohort']),
      ),
    ).toThrow('not an active');
  });
});
