import { CreateTokenRequest } from '@/domain/schemas';
import { toLocalInputValue } from '@/lib/datetime';
import {
  emptyTokenFormValues,
  toCreateTokenInput,
} from '@/lib/tokenFormValues';
import { Schema } from 'effect';
import { describe, expect, test } from 'vitest';

const future = (): string =>
  toLocalInputValue(new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000));

describe('token form values', () => {
  test('sends null expiresAt when Never expires is chosen', async () => {
    const input = toCreateTokenInput({
      ...emptyTokenFormValues(future()),
      name: '  Website form  ',
      neverExpires: true,
    });

    expect(input).toEqual({
      expiresAt: null,
      name: 'Website form',
      type: 'api',
    });
    await expect(
      Schema.decodeUnknownPromise(CreateTokenRequest)(input),
    ).resolves.toEqual(input);
  });

  test('converts a local expiration to a UTC ISO string', async () => {
    const expiration = future();
    const input = toCreateTokenInput({
      ...emptyTokenFormValues(expiration),
      name: 'Website form',
    });

    expect(input.expiresAt).toBe(new Date(expiration).toISOString());
    await expect(
      Schema.decodeUnknownPromise(CreateTokenRequest)(input),
    ).resolves.toEqual(input);
  });

  test('omits an empty expiration so the 90-day default applies', () => {
    const input = toCreateTokenInput({
      ...emptyTokenFormValues(''),
      name: 'Website form',
    });

    expect(input.expiresAt).toBeUndefined();
    expect(JSON.parse(JSON.stringify(input))).toEqual({
      name: 'Website form',
      type: 'api',
    });
  });

  test('keeps the selected browser type', async () => {
    const input = toCreateTokenInput({
      ...emptyTokenFormValues(future()),
      name: 'Browser form',
      type: 'browser',
    });

    expect(input.type).toBe('browser');
    await expect(
      Schema.decodeUnknownPromise(CreateTokenRequest)(input),
    ).resolves.toEqual(input);
  });
});
