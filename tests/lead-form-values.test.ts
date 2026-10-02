import { CreateLeadRequest } from '@/domain/schemas';
import { emptyLeadFormValues, toCreateLeadInput } from '@/leads/leadFormValues';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

describe('lead form values', () => {
  test('maps a filled form to the create contract', async () => {
    const input = toCreateLeadInput({
      email: '  alex@example.com ',
      estimatedValue: '12500',
      firstName: ' Alex ',
      lastName: ' River ',
      source: ' Website ',
    });

    expect(input).toEqual({
      email: 'alex@example.com',
      estimatedValue: 12_500,
      firstName: 'Alex',
      lastName: 'River',
      source: 'Website',
    });
    await expect(
      Schema.decodeUnknownPromise(CreateLeadRequest)(input),
    ).resolves.toEqual(input);
  });

  test('maps empty inputs to omitted optional fields', async () => {
    const input = toCreateLeadInput({
      ...emptyLeadFormValues,
      email: '   ',
      estimatedValue: '',
      firstName: '',
      lastName: '',
    });

    expect(input).toEqual({
      email: undefined,
      estimatedValue: undefined,
      firstName: undefined,
      lastName: undefined,
      source: 'Website',
    });
    // The JSON body actually sent elides undefined fields.
    expect(JSON.parse(JSON.stringify(input))).toEqual({ source: 'Website' });
    await expect(
      Schema.decodeUnknownPromise(CreateLeadRequest)(input),
    ).resolves.toBeDefined();
  });

  test('accepts a zero estimated value', () => {
    expect(
      toCreateLeadInput({ ...emptyLeadFormValues, estimatedValue: '0' }),
    ).toMatchObject({ estimatedValue: 0 });
  });
});
