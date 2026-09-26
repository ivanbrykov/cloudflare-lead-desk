import { type IntakeInput, normalizeEmail } from './schemas';

/**
 * The response persisted for every accepted intake and replayed unchanged on
 * matching retries. One submission creates one lead.
 */
export type IntakeResponse = {
  created: boolean;
  leadId: string;
};

/**
 * Display name for a lead: the explicit name, else the person's name, else the
 * email. Every lead has a stable title for the table without requiring the
 * sender to provide one.
 */
export const leadDisplayName = (input: IntakeInput): string => {
  if (input.name) {
    return input.name;
  }

  const person = [input.firstName, input.lastName]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .trim();
  return person || input.email;
};

/**
 * Idempotency keys: 1-128 printable ASCII characters (0x21-0x7E, no spaces).
 */
const INTAKE_KEY_PATTERN = /^[\u0021-\u007E]{1,128}$/u;

export const isIntakeKey = (key: string): boolean =>
  INTAKE_KEY_PATTERN.test(key);

const canonicalize = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .toSorted()
            .map((key) => [
              key,
              canonicalize((value as Record<string, unknown>)[key]),
            ]),
        )
      : value;

/**
 * Deterministic SHA-256 fingerprint of a static-schema-decoded intake.
 *
 * - Recursively sorts object keys and preserves array order, so JSON
 *   whitespace and property order never create a conflict.
 * - Normalizes the lead email with the existing `normalizeEmail`, so
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
export const intakeRequestFingerprint = async (
  input: IntakeInput,
): Promise<string> => {
  const normalized: IntakeInput = {
    ...input,
    email: normalizeEmail(input.email),
  };
  const canonical = JSON.stringify(canonicalize(normalized));
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};
