import {
  AUTHENTICATION_FAILED_MESSAGE,
  initialRegistrationState,
  INVITE_UNAVAILABLE_MESSAGE,
  type RegistrationEvent,
  registrationReducer,
  type RegistrationState,
  type SignUpFailure,
} from '../src/lib/registration-flow';
import { expect, test } from 'vitest';

/**
 * Regression coverage for the two-step invitation registration state
 * machine (stage s6). The reducer is the single source of truth for the
 * transitions the verifier exercises in the browser:
 *
 *  - step 1 shows only the invite token; a failed validate keeps the user
 *    on step 1 with a generic error;
 *  - step 2 (Name/Email/Password) is revealed only after a successful
 *    validate;
 *  - a 403 `invite_unavailable` sign-up result returns to step 1 and
 *    clears the token and the entered credentials;
 *  - any other sign-up failure stays on step 2;
 *  - Back clears the sensitive fields;
 */

const reduce = (
  state: RegistrationState,
  ...events: RegistrationEvent[]
): RegistrationState => {
  let current = state;
  for (const event of events) {
    current = registrationReducer(current, event);
  }

  return current;
};

const withFields = (
  fields: Partial<RegistrationState['fields']>,
): RegistrationState => {
  const state = initialRegistrationState();
  for (const [name, value] of Object.entries(fields)) {
    state.fields[name as keyof RegistrationState['fields']] = value as string;
  }

  return state;
};

const enteredDetails = (): RegistrationState =>
  reduce(
    withFields({ inviteToken: 'expr1234' }),
    { type: 'token-submit' },
    { ok: true, type: 'token-result' },
    { name: 'name', type: 'field-change', value: 'Ada Lovelace' },
    { name: 'email', type: 'field-change', value: 'ada@example.test' },
    {
      name: 'password',
      type: 'field-change',
      value: 'correct-horse-battery',
    },
  );

const clearedFields = (): RegistrationState['fields'] => ({
  email: '',
  inviteToken: '',
  name: '',
  password: '',
});

test('the flow starts on the token step with empty fields', () => {
  const state = initialRegistrationState();
  expect(state.step).toBe(1);
  expect(state.busy).toBe(false);
  expect(state.error).toBeNull();
  expect(state.fields).toEqual(clearedFields());
});

test('begin-registration always restarts from a clean token step', () => {
  const dirty = reduce(enteredDetails(), { type: 'details-submit' });
  expect(dirty.busy).toBe(true);
  expect(dirty.step).toBe(2);

  const restarted = reduce(dirty, { type: 'begin-registration' });
  expect(restarted).toEqual(initialRegistrationState());
});

test('a failed validate stays on the token step with a generic error', () => {
  const state = reduce(
    withFields({ inviteToken: 'used-token' }),
    { type: 'token-submit' },
    { ok: false, type: 'token-result' },
  );
  expect(state.step).toBe(1);
  expect(state.busy).toBe(false);
  expect(state.error).toBe(INVITE_UNAVAILABLE_MESSAGE);
  // The entered token is kept so the user can retry with a new one.
  expect(state.fields.inviteToken).toBe('used-token');
});

test('a successful validate reveals the details step and keeps the token in state', () => {
  const state = reduce(
    withFields({ inviteToken: 'inva1234' }),
    { type: 'token-submit' },
    { ok: true, type: 'token-result' },
  );
  expect(state.step).toBe(2);
  expect(state.busy).toBe(false);
  expect(state.error).toBeNull();
  expect(state.fields.inviteToken).toBe('inva1234');
});

test('a double token submit is ignored while the first is in flight', () => {
  const first = reduce(withFields({ inviteToken: 'inva1234' }), {
    type: 'token-submit',
  });
  const doubled = reduce(first, { type: 'token-submit' });
  expect(doubled).toBe(first);

  // The late result of the (only) in-flight request is still applied.
  const settled = reduce(doubled, { ok: true, type: 'token-result' });
  expect(settled.step).toBe(2);
});

test('a late token result is ignored once the flow restarted', () => {
  const stale = reduce(
    reduce(withFields({ inviteToken: 'a' }), { type: 'token-submit' }),
    { type: 'begin-registration' },
  );
  const after = reduce(stale, { ok: true, type: 'token-result' });
  expect(after.step).toBe(1);
});

test('a 403 invite_unavailable sign-up result returns to the token step and clears every field', () => {
  const state = reduce(
    enteredDetails(),
    { type: 'details-submit' },
    {
      error: {
        code: 'invite_unavailable',
        status: 403,
      } satisfies SignUpFailure,
      type: 'details-result',
    },
  );
  expect(state.step).toBe(1);
  expect(state.busy).toBe(false);
  expect(state.error).toBe(INVITE_UNAVAILABLE_MESSAGE);
  expect(state.fields).toEqual(clearedFields());
});

test('a 403 invite_unavailable result prefers the server message', () => {
  const state = reduce(
    enteredDetails(),
    { type: 'details-submit' },
    {
      error: {
        code: 'invite_unavailable',
        message: 'Invitation expired.',
        status: 403,
      } satisfies SignUpFailure,
      type: 'details-result',
    },
  );
  expect(state.step).toBe(1);
  expect(state.error).toBe('Invitation expired.');
});

test('an email_exists sign-up result stays on the details step', () => {
  const state = reduce(
    enteredDetails(),
    { type: 'details-submit' },
    {
      error: {
        code: 'email_exists',
        message: 'Email already exists.',
        status: 409,
      } satisfies SignUpFailure,
      type: 'details-result',
    },
  );
  expect(state.step).toBe(2);
  expect(state.busy).toBe(false);
  expect(state.error).toBe('Email already exists.');
  // The token and the rest of the form survive so the user can fix only
  // the offending field.
  expect(state.fields).toEqual(
    expect.objectContaining({
      email: 'ada@example.test',
      inviteToken: 'expr1234',
      name: 'Ada Lovelace',
    }),
  );
});

test('an invite_unavailable code without a 403 status stays on the details step', () => {
  const state = reduce(
    enteredDetails(),
    { type: 'details-submit' },
    {
      error: {
        code: 'invite_unavailable',
        status: 422,
      } satisfies SignUpFailure,
      type: 'details-result',
    },
  );
  expect(state.step).toBe(2);
  expect(state.error).toBe(AUTHENTICATION_FAILED_MESSAGE);
});

test('a validation sign-up result stays on the details step with the server message', () => {
  const state = reduce(
    enteredDetails(),
    { type: 'details-submit' },
    {
      error: {
        message: 'Password must be at least 8 characters.',
        status: 422,
      } satisfies SignUpFailure,
      type: 'details-result',
    },
  );
  expect(state.step).toBe(2);
  expect(state.error).toBe('Password must be at least 8 characters.');
});

test('an unexpected sign-up failure falls back to the generic error', () => {
  const state = reduce(
    enteredDetails(),
    { type: 'details-submit' },
    {
      error: { status: 500 } satisfies SignUpFailure,
      type: 'details-result',
    },
  );
  expect(state.step).toBe(2);
  expect(state.error).toBe(AUTHENTICATION_FAILED_MESSAGE);
});

test('a successful sign-up clears the error and releases the in-flight flag', () => {
  const state = reduce(reduce(enteredDetails(), { type: 'details-submit' }), {
    error: null,
    type: 'details-result',
  });
  expect(state.step).toBe(2);
  expect(state.busy).toBe(false);
  expect(state.error).toBeNull();
});

test('a double details submit is ignored while the first is in flight', () => {
  const first = reduce(enteredDetails(), { type: 'details-submit' });
  const doubled = reduce(first, { type: 'details-submit' });
  expect(doubled).toBe(first);
});

test('details submits are ignored on the token step and vice versa', () => {
  const onToken = withFields({ inviteToken: 'inva1234' });
  expect(reduce(onToken, { type: 'details-submit' })).toBe(onToken);

  const onDetails = reduce(
    withFields({ inviteToken: 'inva1234' }),
    { type: 'token-submit' },
    { ok: true, type: 'token-result' },
  );
  expect(reduce(onDetails, { type: 'token-submit' })).toBe(onDetails);
});

test('a late details result is ignored once the flow restarted', () => {
  const inFlight = reduce(enteredDetails(), { type: 'details-submit' });
  const restarted = reduce(inFlight, { type: 'begin-registration' });
  const after = reduce(restarted, {
    error: { code: 'invite_unavailable', status: 403 } satisfies SignUpFailure,
    type: 'details-result',
  });
  expect(after).toEqual(initialRegistrationState());
});

test('back to the token step clears the token and the sensitive fields', () => {
  const state = reduce(enteredDetails(), { type: 'back-to-token' });
  expect(state.step).toBe(1);
  expect(state.busy).toBe(false);
  expect(state.error).toBeNull();
  expect(state.fields).toEqual(clearedFields());
});

test('a full expiry race: valid validate, then invite_unavailable at sign-up', () => {
  const state = reduce(
    withFields({ inviteToken: 'expr1234' }),
    { type: 'token-submit' },
    { ok: true, type: 'token-result' },
    { name: 'name', type: 'field-change', value: 'Ada Lovelace' },
    { name: 'email', type: 'field-change', value: 'ada@example.test' },
    { name: 'password', type: 'field-change', value: 'correct-horse-battery' },
    { type: 'details-submit' },
    {
      error: {
        code: 'invite_unavailable',
        status: 403,
      } satisfies SignUpFailure,
      type: 'details-result',
    },
  );
  expect(state.step).toBe(1);
  expect(state.busy).toBe(false);
  expect(state.error).toBe(INVITE_UNAVAILABLE_MESSAGE);
  expect(state.fields).toEqual(clearedFields());
  // The flow is usable again after the race.
  const retry = reduce(
    state,
    { name: 'inviteToken', type: 'field-change', value: 'inva1234' },
    { type: 'token-submit' },
    { ok: true, type: 'token-result' },
  );
  expect(retry.step).toBe(2);
  expect(retry.fields.inviteToken).toBe('inva1234');
});
