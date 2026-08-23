import { describe, expect, test } from 'vitest';
import { validateCustomFields } from '@/domain/custom-fields';

const fields = [
  {
    id: '00000000-0000-4000-8000-000000000010',
    key: 'cohort',
    options: ['Fall', 'Spring'],
    required: true,
    type: 'select' as const,
  },
  {
    id: '00000000-0000-4000-8000-000000000011',
    key: 'children_count',
    options: [],
    required: false,
    type: 'number' as const,
  },
];

describe('dynamic custom field validation', () => {
  test('normalizes an active field value into a typed persistence value', () => {
    expect(
      validateCustomFields('opportunity', fields, {
        children_count: 2,
        cohort: 'Fall',
      }),
    ).toEqual([
      {
        fieldId: '00000000-0000-4000-8000-000000000010',
        valueBoolean: null,
        valueDate: null,
        valueNumber: null,
        valueText: 'Fall',
      },
      {
        fieldId: '00000000-0000-4000-8000-000000000011',
        valueBoolean: null,
        valueDate: null,
        valueNumber: 2,
        valueText: null,
      },
    ]);
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
