import type { IntakeInput } from './schemas';
import { normalizeEmail } from './schemas';

/**
 * The response persisted for every accepted intake and replayed unchanged on
 * matching retries. Kept in this shape for compatibility with clients written
 * against the original contract.
 */
export interface IntakeResponse {
  created: boolean;
  opportunityId: string;
}

/** Idempotency keys: 1-128 printable ASCII characters (0x21-0x7E, no spaces). */
const INTAKE_KEY_PATTERN = /^[\u0021-\u007e]{1,128}$/;

export const isIntakeKey = (key: string): boolean => INTAKE_KEY_PATTERN.test(key);

const canonicalize = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
        )
      : value;

/**
 * Deterministic SHA-256 fingerprint of a static-schema-decoded intake.
 *
 * - Recursively sorts object keys and preserves array order, so JSON
 *   whitespace and property order never create a conflict.
 * - Normalizes the contact email with the existing `normalizeEmail`, so
 *   case/whitespace differences in the email never create a conflict either.
 * - Uses no field-definition or pipeline lookup: the fingerprint is a pure
 *   function of the decoded request, so mutable workspace state can never
 *   change whether a retry is recognized.
 *
 * Omitted optional properties are absent from the decoded value, while an
 * explicitly supplied optional value (including `customFields: {}`) is
 * fingerprinted as-is; omitted versus explicitly supplied may therefore
 * remain different.
 */
export const intakeRequestFingerprint = async (input: IntakeInput): Promise<string> => {
  const normalized: IntakeInput = {
    ...input,
    contact: { ...input.contact, email: normalizeEmail(input.contact.email) },
  };
  const canonical = JSON.stringify(canonicalize(normalized));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};
