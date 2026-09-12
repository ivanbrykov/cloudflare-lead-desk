import {
  customFieldsForCreate,
  customFieldsForUpdate,
  isBlankCustomFieldValue,
} from '@/lib/custom-field-form';
import { describe, expect, test } from 'vitest';

describe('custom field form payloads', () => {
  test('creation omits cleared optional fields but keeps real values', () => {
    expect(
      customFieldsForCreate({
        cleared: null,
        consent: false,
        count: 0,
        name: 'Fall',
      }),
    ).toEqual({ consent: false, count: 0, name: 'Fall' });
    expect(customFieldsForCreate({ cleared: null })).toBeUndefined();
    expect(customFieldsForCreate({})).toBeUndefined();
  });

  test('update keeps cleared optional fields as explicit nulls', () => {
    expect(
      customFieldsForUpdate({ cleared: null, consent: false }, [
        { key: 'cleared' },
        { key: 'consent' },
      ]),
    ).toEqual({
      cleared: null,
      consent: false,
    });
    expect(customFieldsForUpdate({}, [])).toBeUndefined();
  });

  test('editing a cached contact drops archived keys using current definitions', () => {
    const cached = {
      archived: 'old value',
      cleared: null,
      consent: false,
      count: 0,
    };
    expect(
      customFieldsForUpdate(cached, [
        { key: 'consent' },
        { key: 'cleared' },
        { key: 'count' },
      ]),
    ).toEqual({ cleared: null, consent: false, count: 0 });
    expect(customFieldsForUpdate(cached, [])).toBeUndefined();
    expect(cached.archived).toBe('old value');
  });

  test('blank detection treats null and empty string as missing, false and 0 as values', () => {
    expect(isBlankCustomFieldValue(undefined)).toBe(true);
    expect(isBlankCustomFieldValue(null)).toBe(true);
    expect(isBlankCustomFieldValue('')).toBe(true);
    expect(isBlankCustomFieldValue(false)).toBe(false);
    expect(isBlankCustomFieldValue(0)).toBe(false);
  });
});
