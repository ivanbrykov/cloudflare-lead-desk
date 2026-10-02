import { decodeKeysetCursor, encodeKeysetCursor } from '@/domain/pagination';
import { expect, test } from 'vitest';

/**
 * Cursor decoding is strict: the shape check alone accepts impossible calendar
 * instants, and the repository binds Date.parse(createdAt) as a real seek
 * timestamp. Server-issued cursors must still round-trip.
 */

// The cursor wire names c/i/v are intentional; see encodeKeysetCursor.
/* eslint-disable id-length -- c/i/v are the stable cursor wire names. */
const cursorFor = (createdAt: string): string =>
  Buffer.from(JSON.stringify({ c: createdAt, i: 'x', v: 1 })).toString(
    'base64url',
  );
/* eslint-enable id-length */

test('a server-issued cursor round-trips', () => {
  const keyset = {
    createdAt: '2026-09-30T01:41:22.123Z',
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA00',
  };
  expect(decodeKeysetCursor(encodeKeysetCursor(keyset))).toEqual(keyset);
});

test('impossible calendar instants are rejected', () => {
  for (const createdAt of [
    '2026-99-99T00:00:00.000Z',
    '2026-02-30T00:00:00.000Z',
    '2026-09-30T25:00:00.000Z',
    '2026-09-30T00:60:00.000Z',
    '2026-09-00T00:00:00.000Z',
  ]) {
    expect(decodeKeysetCursor(cursorFor(createdAt)), createdAt).toBeNull();
  }
});

test('non-canonical instants are rejected', () => {
  for (const createdAt of [
    // encodeKeysetCursor always emits exactly millisecond precision.
    '2026-09-30T01:41:22Z',
    '2026-09-30T01:41:22.1Z',
    '2026-09-30T01:41:22.12Z',
    '2026-09-30T01:41:22.1234Z',
  ]) {
    expect(decodeKeysetCursor(cursorFor(createdAt)), createdAt).toBeNull();
  }
});

test('valid millisecond-precision instants decode', () => {
  const createdAt = '2026-09-30T01:41:22.000Z';
  expect(decodeKeysetCursor(cursorFor(createdAt))).toEqual({
    createdAt,
    id: 'x',
  });
});
