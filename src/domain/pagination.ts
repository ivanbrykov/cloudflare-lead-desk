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

const BASE64URL_CHARS = /^[A-Za-z0-9_-]+$/;

// Every created_at written by the app is a UTC ISO-8601 instant
// (Date.prototype.toISOString), so a cursor whose createdAt does not match
// this shape is treated as tampered rather than as a seek position.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface ContactKeyset {
  createdAt: string;
  id: string;
}

const toBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): string | null => {
  if (value.length === 0 || value.length % 4 === 1 || !BASE64URL_CHARS.test(value)) {
    return null;
  }
  const canonical = value.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(canonical + '='.repeat((4 - (canonical.length % 4)) % 4));
  } catch {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    return null;
  }
};

export const encodeContactCursor = (keyset: ContactKeyset): string =>
  toBase64Url(JSON.stringify({ c: keyset.createdAt, i: keyset.id, v: 1 }));

export const decodeContactCursor = (cursor: string): ContactKeyset | null => {
  const encoded = fromBase64Url(cursor);
  if (encoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { c, i, v } = parsed as { c?: unknown; i?: unknown; v?: unknown };
  if (v !== 1 || typeof c !== 'string' || typeof i !== 'string') return null;
  if (c.length === 0 || i.length === 0 || !ISO_INSTANT.test(c)) return null;
  return { createdAt: c, id: i };
};

export const CONTACT_LIMIT_DEFAULT = 50;
export const CONTACT_LIMIT_MIN = 1;
export const CONTACT_LIMIT_MAX = 100;

/**
 * Strict limit validation: only a plain integer string in [1, 100] is
 * accepted. Anything else (non-numeric, fractional, empty, out of range)
 * is rejected so the caller can answer 422 validation_error.
 */
export const parseContactLimit = (value: unknown): number | null => {
  // Only plain unsigned integer strings are page sizes. Number() alone would
  // also accept '1e2', '0x32', ' 50', '+5', ... - not what clients mean.
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (parsed < CONTACT_LIMIT_MIN || parsed > CONTACT_LIMIT_MAX) return null;
  return parsed;
};
