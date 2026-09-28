import { CreateLeadRequest, IntakeRequest } from '@/domain/schemas';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

describe('intake contract', () => {
  test('decodes a valid public form submission', async () => {
    const input = await Schema.decodeUnknownPromise(IntakeRequest)({
      email: 'alex@example.com',
      firstName: 'Alex',
      name: 'New service inquiry',
      source: 'website_form',
    });
    expect(input.email).toBe('alex@example.com');
    expect(input.name).toContain('service');
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
      name: 'New service inquiry',
      source: 'Manual entry',
    });
    expect(input.name).toContain('service');
  });
});
