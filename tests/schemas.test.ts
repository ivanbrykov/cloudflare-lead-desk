import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';
import { IntakeInputSchema } from '@/domain/schemas';

describe('intake contract', () => {
  test('decodes a valid public form submission', async () => {
    const input = await Schema.decodeUnknownPromise(IntakeInputSchema)({
      contact: { email: 'sam@example.com', firstName: 'Sam' },
      opportunity: { name: 'Rivera family — Fall', source: 'calculator' },
      source: 'ileo',
    });
    expect(input.contact.email).toBe('sam@example.com');
    expect(input.opportunity.name).toContain('Rivera');
  });

  test('rejects a missing source and invalid email', async () => {
    await expect(
      Schema.decodeUnknownPromise(IntakeInputSchema)({
        contact: { email: 'not-an-email' },
        opportunity: { name: 'Inquiry', source: 'calculator' },
      }),
    ).rejects.toThrow();
  });
});
