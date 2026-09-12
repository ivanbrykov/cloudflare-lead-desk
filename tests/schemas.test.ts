import { CreateOpportunitySchema, IntakeInputSchema } from '@/domain/schemas';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

describe('intake contract', () => {
  test('decodes a valid public form submission', async () => {
    const input = await Schema.decodeUnknownPromise(IntakeInputSchema)({
      contact: { email: 'alex@example.com', firstName: 'Alex' },
      opportunity: { name: 'New service inquiry', source: 'calculator' },
      source: 'website_form',
    });
    expect(input.contact.email).toBe('alex@example.com');
    expect(input.opportunity.name).toContain('service');
  });

  test('rejects a missing source and invalid email', async () => {
    await expect(
      Schema.decodeUnknownPromise(IntakeInputSchema)({
        contact: { email: 'not-an-email' },
        opportunity: { name: 'Inquiry', source: 'calculator' },
      }),
    ).rejects.toThrow();
  });

  test('decodes a manual opportunity for an existing contact', async () => {
    const input = await Schema.decodeUnknownPromise(CreateOpportunitySchema)({
      contactId: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
      name: 'New service inquiry',
      source: 'Manual entry',
    });
    expect(input.contactId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAY');
    expect(input.name).toContain('service');
  });
});
