import { leadDisplayName } from '@/domain/leadDisplay';
import { describe, expect, test } from 'vitest';

describe('leadDisplayName', () => {
  test('prefers the person name', () => {
    expect(
      leadDisplayName({
        email: 'alex@example.test',
        firstName: 'Alex',
        lastName: 'Rivera',
      }),
    ).toBe('Alex Rivera');
    expect(
      leadDisplayName({
        email: 'alex@example.test',
        firstName: 'Alex',
        lastName: null,
      }),
    ).toBe('Alex');
    expect(
      leadDisplayName({
        email: 'alex@example.test',
        firstName: null,
        lastName: 'Rivera',
      }),
    ).toBe('Rivera');
  });

  test('trims surrounding whitespace in name parts', () => {
    expect(
      leadDisplayName({
        email: null,
        firstName: '  Alex ',
        lastName: ' Rivera  ',
      }),
    ).toBe('Alex Rivera');
  });

  test('falls back to the email', () => {
    expect(
      leadDisplayName({
        email: 'alex@example.test',
        firstName: null,
        lastName: null,
      }),
    ).toBe('alex@example.test');
    expect(
      leadDisplayName({
        email: 'alex@example.test',
        firstName: '  ',
        lastName: '',
      }),
    ).toBe('alex@example.test');
  });

  test('returns null when nothing identifies the lead', () => {
    expect(
      leadDisplayName({ email: null, firstName: null, lastName: null }),
    ).toBeNull();
  });
});
