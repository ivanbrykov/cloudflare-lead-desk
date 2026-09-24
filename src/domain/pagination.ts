/**
 * Keyset (seek) pagination for the contact list.
 *
 * The cursor encodes the (createdAt, id) position of the last row of the
 * previous page over the list's deterministic ordering (createdAt DESC,
 * id DESC). The encoding is base64url of a small JSON object so the cursor
 * stays opaque to clients; decoding is strict, so truncated, base64-corrupt,
 * or structurally invalid cursors are rejected with 422 invalid_cursor
 * instead of silently shifting the page window.
 */

const URL_BASE64_ALPHABET = /^[\w-]+$/u;

// The cursor payload carries createdAt as a UTC ISO-8601 instant
// (Date.prototype.toISOString) even though timestamps are stored as Unix
// milliseconds, so a cursor whose createdAt does not match this shape is
// treated as tampered rather than as a seek position.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

export type ContactKeyset = {
  createdAt: string;
  id: string;
};

const toBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  let encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
  // btoa pads with trailing '=' characters, which base64url omits
  while (encoded.endsWith('=')) {
    encoded = encoded.slice(0, -1);
  }

  return encoded;
};

const fromBase64Url = (value: string): null | string => {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !URL_BASE64_ALPHABET.test(value)
  ) {
    return null;
  }

  const canonical = value.replaceAll('-', '+').replaceAll('_', '/');
  let binary: string;
  try {
    binary = atob(canonical + '='.repeat((4 - (canonical.length % 4)) % 4));
  } catch {
    return null;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0),
    );
  } catch {
    return null;
  }
};

export const encodeContactCursor = (keyset: ContactKeyset): string => {
  // 'c', 'i', and 'v' are the stable wire names of the opaque cursor
  // payload; already-issued cursors must keep decoding, so they stay short
  const payload: Record<string, unknown> = {};
  payload['c'] = keyset.createdAt;
  payload['i'] = keyset.id;
  payload['v'] = 1;
  return toBase64Url(JSON.stringify(payload));
};

export const decodeContactCursor = (cursor: string): ContactKeyset | null => {
  const encoded = fromBase64Url(cursor);
  if (encoded === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const payload = parsed as { c?: unknown; i?: unknown; v?: unknown };
  const createdAt = payload.c;
  const id = payload.i;
  const version = payload.v;
  if (
    version !== 1 ||
    typeof createdAt !== 'string' ||
    typeof id !== 'string'
  ) {
    return null;
  }

  if (
    createdAt.length === 0 ||
    id.length === 0 ||
    !ISO_INSTANT.test(createdAt)
  ) {
    return null;
  }

  return { createdAt, id };
};

export const CONTACT_LIMIT_DEFAULT = 50;
export const CONTACT_LIMIT_MIN = 1;
export const CONTACT_LIMIT_MAX = 100;

/**
 * Strict limit validation: only a plain integer string in [1, 100] is
 * accepted. Anything else (non-numeric, fractional, empty, out of range)
 * is rejected so the caller can answer 422 validation_error.
 */
export const parseContactLimit = (value: unknown): null | number => {
  // Only plain unsigned integer strings are page sizes. Number() alone would
  // also accept '1e2', '0x32', ' 50', '+5', ... - not what clients mean.
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (parsed < CONTACT_LIMIT_MIN || parsed > CONTACT_LIMIT_MAX) {
    return null;
  }

  return parsed;
};
