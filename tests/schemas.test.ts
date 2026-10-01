import { CreateLeadRequest, IntakeRequest } from '@/domain/schemas';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

describe('intake contract', () => {
  test('decodes a valid public form submission', async () => {
    const input = await Schema.decodeUnknownPromise(IntakeRequest)({
      email: 'alex@example.com',
      firstName: 'Alex',
      source: 'website_form',
    });
    expect(input.email).toBe('alex@example.com');
    expect(input.firstName).toBe('Alex');
  });

  test('accepts bounded skipped-field diagnostics and rejects bad ones', async () => {
    const input = await Schema.decodeUnknownPromise(IntakeRequest)({
      email: 'alex@example.com',
      skippedFields: [{ name: 'company', reason: 'unmarked' }],
      source: 'website_form',
    });
    expect(input.skippedFields).toEqual([
      { name: 'company', reason: 'unmarked' },
    ]);

    await expect(
      Schema.decodeUnknownPromise(IntakeRequest)({
        email: 'alex@example.com',
        skippedFields: [{ name: 'company', reason: 'guessed' }],
        source: 'website_form',
      }),
    ).rejects.toThrow();

    await expect(
      Schema.decodeUnknownPromise(IntakeRequest)({
        email: 'alex@example.com',
        skippedFields: Array.from({ length: 51 }, (_, index) => ({
          name: `field${String(index)}`,
          reason: 'unmarked',
        })),
        source: 'website_form',
      }),
    ).rejects.toThrow();

    await expect(
      Schema.decodeUnknownPromise(IntakeRequest)({
        email: 'alex@example.com',
        skippedFields: [{ name: 'x'.repeat(121), reason: 'unmarked' }],
        source: 'website_form',
      }),
    ).rejects.toThrow();
  });

  test('rejects a missing source and invalid email', async () => {
    await expect(
      Schema.decodeUnknownPromise(IntakeRequest)({
        email: 'not-an-email',
        source: 'calculator',
      }),
    ).rejects.toThrow();

    await expect(
      Schema.decodeUnknownPromise(IntakeRequest)({
        email: 'alex@example.com',
      }),
    ).rejects.toThrow();
  });

  test('decodes a manual lead', async () => {
    const input = await Schema.decodeUnknownPromise(CreateLeadRequest)({
      email: 'alex@example.com',
      source: 'Manual entry',
    });
    expect(input.email).toBe('alex@example.com');
  });
});
