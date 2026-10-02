// Pure state machine for the two-step invitation registration UI.
//
// The reducer owns the transient registration state (step, error, and
// in-flight flag). Field values live in react-hook-form inside the
// component: the invite token and the entered credentials are only ever
// held in that component-local state (never storage, URLs, or a
// module-level cache), and the component resets both forms on the
// back/retry transitions.
//
// Kept free of React so the transitions stay testable in the node test
// environment. The component adds a synchronous ref guard on top of the
// reducer's busy flag to absorb rapid double submits before a re-render.

export const INVITE_UNAVAILABLE_MESSAGE = 'Invitation is unavailable.';
export const AUTHENTICATION_FAILED_MESSAGE = 'Authentication failed.';

export type RegistrationEvent =
  | { error: null | SignUpFailure; type: 'details-result' }
  | { ok: boolean; type: 'token-result' }
  | { type: 'back-to-token' }
  | { type: 'begin-registration' }
  | { type: 'details-submit' }
  | { type: 'token-submit' };

export type RegistrationState = {
  busy: boolean;
  error: null | string;
  step: RegistrationStep;
};

export type RegistrationStep = 1 | 2;

// The subset of the Better Auth client error shape the UI relies on. The
// client (better-auth 1.7 with @better-fetch/fetch) spreads the parsed
// response body into the error object and adds the HTTP status, so both
// the server-provided message and status are available here.
export type SignUpFailure = {
  code?: string;
  message?: string;
  status?: number;
};

export const initialRegistrationState = (): RegistrationState => ({
  busy: false,
  error: null,
  step: 1,
});

export const isInviteUnavailable = (error: SignUpFailure): boolean =>
  error.code === 'invite_unavailable' && error.status === 403;

export const registrationReducer = (
  state: RegistrationState,
  event: RegistrationEvent,
): RegistrationState => {
  switch (event.type) {
    case 'back-to-token':
      // Going back resets the flow; the component must also reset the
      // forms so the token and the credentials are discarded.
      return initialRegistrationState();

    case 'begin-registration':
      // Start a fresh, fully cleared flow: anything the sign-in form held
      // is not carried into the registration branch.
      return initialRegistrationState();

    case 'details-result':
      if (!state.busy || state.step !== 2) {
        return state;
      }

      if (event.error === null) {
        return { ...state, busy: false, error: null };
      }

      if (isInviteUnavailable(event.error)) {
        // The grant was used or expired while the details were typed;
        // restart from the token step. The component resets the forms so
        // the grant and the credentials are not kept.
        return {
          ...initialRegistrationState(),
          error: event.error.message ?? INVITE_UNAVAILABLE_MESSAGE,
        };
      }

      // Ordinary invalid, duplicate, and validation errors stay on the
      // details step so the user can fix the form without a new token.
      return {
        ...state,
        busy: false,
        error: event.error.message ?? AUTHENTICATION_FAILED_MESSAGE,
      };

    case 'details-submit':
      if (state.busy || state.step !== 2) {
        return state;
      }

      return { ...state, busy: true, error: null };

    case 'token-result':
      if (!state.busy || state.step !== 1) {
        return state;
      }

      if (event.ok) {
        // Step 2 is revealed only on success; the component reads the
        // token from its form when the details submit needs it.
        return { ...state, busy: false, error: null, step: 2 };
      }

      // Every non-2xx (or transport) failure is reported the same way so
      // the UI does not reveal which check failed.
      return { ...state, busy: false, error: INVITE_UNAVAILABLE_MESSAGE };

    case 'token-submit':
      if (state.busy || state.step !== 1) {
        return state;
      }

      return { ...state, busy: true, error: null };

    default:
      // Exhaustive over RegistrationEvent; kept so the reducer always
      // returns a state.
      return state;
  }
};
