import { intakeRequestFingerprint, isIntakeKey } from '@/domain/intake';
import { type IntakeInput } from '@/domain/schemas';
import { describe, expect, test } from 'vitest';

const baseInput = (overrides: Partial<IntakeInput> = {}): IntakeInput => ({
  customFields: overrides.customFields,
  email: overrides.email ?? 'Alex@Example.COM',
  estimatedValue: overrides.estimatedValue,
  firstName: overrides.firstName ?? ' Alex ',
  lastName: overrides.lastName,
  name: overrides.name ?? 'New inquiry',
  pipelineId: overrides.pipelineId,
  source: overrides.source ?? 'website_form',
  stageId: overrides.stageId,
});

describe('intake request fingerprint', () => {
  test('is stable across object property order', async () => {
    const a = baseInput();
    const b: IntakeInput = {
      email: 'Alex@Example.COM',
      firstName: ' Alex ',
      name: 'New inquiry',
      source: 'website_form',
    };
    expect(await intakeRequestFingerprint(b)).toBe(
      await intakeRequestFingerprint(a),
    );
  });

  test('normalizes email case and surrounding whitespace', async () => {
    const a = baseInput();
    const b = baseInput({ email: '  alex@example.com ' });
    expect(await intakeRequestFingerprint(b)).toBe(
      await intakeRequestFingerprint(a),
    );
  });

  test('preserves array order inside custom fields', async () => {
    const a = baseInput({ customFields: { tags: ['first', 'second'] } });
    const b = baseInput({ customFields: { tags: ['second', 'first'] } });
    expect(await intakeRequestFingerprint(b)).not.toBe(
      await intakeRequestFingerprint(a),
    );
  });

  test('omitted versus explicitly supplied optional values may differ', async () => {
    const omitted = baseInput();
    const explicitZero = baseInput({ estimatedValue: 0 });
    const explicitEmptyCustomFields = baseInput({
      customFields: {},
      email: 'Alex@Example.COM',
      firstName: ' Alex ',
    });
    expect(await intakeRequestFingerprint(explicitZero)).not.toBe(
      await intakeRequestFingerprint(omitted),
    );
    expect(await intakeRequestFingerprint(explicitEmptyCustomFields)).not.toBe(
      await intakeRequestFingerprint(omitted),
    );
  });

  test('changes to any field change the fingerprint', async () => {
    const a = baseInput();
    const renamed = baseInput({ name: 'Changed inquiry' });
    expect(await intakeRequestFingerprint(renamed)).not.toBe(
      await intakeRequestFingerprint(a),
    );
  });

  test('produces a 64-character hex SHA-256 digest', async () => {
    expect(await intakeRequestFingerprint(baseInput())).toMatch(
      /^[\da-f]{64}$/u,
    );
  });
});

describe('intake key validation', () => {
  test('accepts 1-128 printable ASCII characters', () => {
    expect(isIntakeKey('k')).toBe(true);
    expect(isIntakeKey('k'.repeat(128))).toBe(true);
    expect(isIntakeKey('!')).toBe(true);
    expect(isIntakeKey('~')).toBe(true);
  });

  test('rejects empty, too long, non-ASCII, and whitespace keys', () => {
    expect(isIntakeKey('')).toBe(false);
    expect(isIntakeKey('k'.repeat(129))).toBe(false);
    expect(isIntakeKey('contains space')).toBe(false);
    expect(isIntakeKey('héllo')).toBe(false);
    expect(isIntakeKey('tab\there')).toBe(false);
  });
});
