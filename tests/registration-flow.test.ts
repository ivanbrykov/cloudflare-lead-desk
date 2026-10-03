import {
  AUTHENTICATION_FAILED_MESSAGE,
  initialRegistrationState,
  INVITE_UNAVAILABLE_MESSAGE,
  isInviteUnavailable,
  type RegistrationEvent,
  registrationReducer,
  type RegistrationState,
  type SignUpFailure,
} from '../src/lib/registration-flow';
import { expect, test } from 'vitest';

/**
 * Regression coverage for the two-step invitation registration state
 * machine. The reducer owns step/error/in-flight transitions; the field
 * values live in react-hook-form inside the login page, which resets the
 * forms whenever the reducer restarts the flow (Back, invite_unavailable).
 *
 *  - step 1 shows only the invite token; a failed validate keeps the user
 *    on step 1 with a generic error;
 *  - step 2 (Name/Email/Password) is revealed only after a successful
 *    validate;
 *  - a 403 `invite_unavailable` sign-up result returns to step 1;
 *  - any other sign-up failure stays on step 2;
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

const enteredDetails = (): RegistrationState =>
  reduce(
    initialRegistrationState(),
    { type: 'token-submit' },
    { ok: true, type: 'token-result' },
  );

test('the flow starts on the token step', () => {
  const state = initialRegistrationState();
  expect(state.step).toBe(1);
  expect(state.busy).toBe(false);
  expect(state.error).toBeNull();
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
    initialRegistrationState(),
    { type: 'token-submit' },
    { ok: false, type: 'token-result' },
  );
  expect(state.step).toBe(1);
  expect(state.busy).toBe(false);
  expect(state.error).toBe(INVITE_UNAVAILABLE_MESSAGE);
});

test('a successful validate reveals the details step', () => {
  const state = enteredDetails();
  expect(state.step).toBe(2);
  expect(state.busy).toBe(false);
  expect(state.error).toBeNull();
});

test('a double token submit is ignored while the first is in flight', () => {
  const first = reduce(initialRegistrationState(), { type: 'token-submit' });
  const doubled = reduce(first, { type: 'token-submit' });
  expect(doubled).toBe(first);

  // The late result of the (only) in-flight request is still applied.
  const settled = reduce(doubled, { ok: true, type: 'token-result' });
  expect(settled.step).toBe(2);
});

test('a late token result is ignored once the flow restarted', () => {
  const stale = reduce(
    reduce(initialRegistrationState(), { type: 'token-submit' }),
    { type: 'begin-registration' },
  );
  const after = reduce(stale, { ok: true, type: 'token-result' });
  expect(after.step).toBe(1);
});

test('a 403 invite_unavailable sign-up result returns to the token step', () => {
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
  const onToken = initialRegistrationState();
  expect(reduce(onToken, { type: 'details-submit' })).toBe(onToken);

  const onDetails = enteredDetails();
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

test('back to the token step resets the flow', () => {
  const state = reduce(enteredDetails(), { type: 'back-to-token' });
  expect(state.step).toBe(1);
  expect(state.busy).toBe(false);
  expect(state.error).toBeNull();
});

test('isInviteUnavailable is the exact 403 invite_unavailable signal', () => {
  expect(isInviteUnavailable({ code: 'invite_unavailable', status: 403 })).toBe(
    true,
  );
  expect(isInviteUnavailable({ code: 'invite_unavailable', status: 422 })).toBe(
    false,
  );
  expect(isInviteUnavailable({ status: 403 })).toBe(false);
});
