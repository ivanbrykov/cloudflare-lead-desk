import { describe, expect, test } from 'vitest';
import {
  customFieldsForCreate,
  customFieldsForUpdate,
  isBlankCustomFieldValue,
} from '@/lib/custom-field-form';

describe('custom field form payloads', () => {
  test('creation omits cleared optional fields but keeps real values', () => {
    expect(
      customFieldsForCreate({ cleared: null, consent: false, name: 'Fall', count: 0 }),
    ).toEqual({ consent: false, name: 'Fall', count: 0 });
    expect(customFieldsForCreate({ cleared: null })).toBeUndefined();
    expect(customFieldsForCreate({})).toBeUndefined();
  });

  test('update keeps cleared optional fields as explicit nulls', () => {
    expect(customFieldsForUpdate({ cleared: null, consent: false })).toEqual({
      cleared: null,
      consent: false,
    });
    expect(customFieldsForUpdate({})).toBeUndefined();
  });

  test('blank detection treats null and empty string as missing, false and 0 as values', () => {
    expect(isBlankCustomFieldValue(undefined)).toBe(true);
    expect(isBlankCustomFieldValue(null)).toBe(true);
    expect(isBlankCustomFieldValue('')).toBe(true);
    expect(isBlankCustomFieldValue(false)).toBe(false);
    expect(isBlankCustomFieldValue(0)).toBe(false);
  });
});
