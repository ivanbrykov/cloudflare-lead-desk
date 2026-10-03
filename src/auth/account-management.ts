/**
 * Self-service account management boundary for the two Better Auth
 * endpoints the account settings page drives.
 *
 * Better Auth's own handlers already enforce the session, the origin
 * (CSRF), the credential check, password hashing, the session re-issue, and
 * the change-password rate limit (3 per 10s, database-backed). What they do
 * not enforce is the application's field policy: `/update-user` accepts an
 * unvalidated record, and `/change-password` accepts any string lengths.
 * This boundary applies the same bounds the invitation sign-up applies
 * (name 1..200 trimmed; password 8..255, not whitespace-only) BEFORE Better
 * Auth runs, so an invalid body costs no scrypt work and produces the
 * app's standard `{ code, message }` error envelope.
 *
 * Email stays out of scope: LeadScroll has no email-sending infrastructure,
 * so Better Auth's `/change-email` (which requires a verification sender)
 * is left disabled, and this boundary rejects any `email` field on
 * `/update-user` the way Better Auth itself would.
 *
 * Like the sign-in guard, the request body is read by the caller and must be
 * re-attached: constructing the forwarded Request consumes the stream.
 */

import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
} from '@/auth';

const NAME_MAX = 200;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 255;

type AuthForRequest = (request: Request) => Auth;

type ParsedBody = { body: Record<string, unknown> };

const errorResponse = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status });

const bodyError = () =>
  errorResponse(
    422,
    'validation_error',
    'The request body must be a JSON object.',
  );

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateName = (name: string): null | string => {
  if (name === '') {
    return 'name is required.';
  }

  if (name.length > NAME_MAX) {
    return `name must be at most ${NAME_MAX} characters.`;
  }

  return null;
};

const validatePassword = (
  field: 'currentPassword' | 'newPassword',
  password: string,
): null | string => {
  if (password.length < PASSWORD_MIN) {
    return `${field} must be at least ${PASSWORD_MIN} characters.`;
  }

  if (password.length > PASSWORD_MAX) {
    return `${field} must be at most ${PASSWORD_MAX} characters.`;
  }

  if (password.trim() === '') {
    return `${field} must not consist only of whitespace.`;
  }

  return null;
};

const forwarded = (request: Request, rawBody: string) => {
  const url = new URL(request.url);
  url.pathname = `/api/auth${url.pathname}`;
  return new Request(url, {
    body: rawBody,
    headers: request.headers,
    method: request.method,
  });
};

const parseChangePassword = (raw: string): ParsedBody | Response => {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return bodyError();
  }

  if (!isPlainObject(payload)) {
    return bodyError();
  }

  const currentPassword =
    typeof payload.currentPassword === 'string' ? payload.currentPassword : '';
  const newPassword =
    typeof payload.newPassword === 'string' ? payload.newPassword : '';
  if (currentPassword === '' || newPassword === '') {
    return errorResponse(
      422,
      'validation_error',
      'currentPassword and newPassword are required.',
    );
  }

  const currentError = validatePassword('currentPassword', currentPassword);
  if (currentError) {
    return errorResponse(422, 'validation_error', currentError);
  }

  const newError = validatePassword('newPassword', newPassword);
  if (newError) {
    return errorResponse(422, 'validation_error', newError);
  }

  return {
    body: { currentPassword, newPassword, revokeOtherSessions: true },
  };
};

const parseUpdateUser = (raw: string): ParsedBody | Response => {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return bodyError();
  }

  if (!isPlainObject(payload)) {
    return bodyError();
  }

  if ('email' in payload) {
    return errorResponse(
      422,
      'validation_error',
      'The email address cannot be changed on this deployment.',
    );
  }

  // Better Auth's update handler accepts an arbitrary record; this app's
  // profile surface is the name alone, so anything else is a client bug.
  const unexpected = Object.keys(payload).filter((key) => key !== 'name');
  if (unexpected.length > 0) {
    return errorResponse(
      422,
      'validation_error',
      `Unexpected field(s): ${unexpected.toSorted().join(', ')}. Only name can be updated.`,
    );
  }

  if (!('name' in payload)) {
    return errorResponse(422, 'validation_error', 'name is required.');
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const nameError = validateName(name);
  if (nameError) {
    return errorResponse(422, 'validation_error', nameError);
  }

  // Only the validated fields pass through; an unvalidated record must not
  // reach Better Auth's permissive update.
  return { body: { name } };
};

export type AccountAuthEndpoints = {
  changePassword: (request: Request, raw: string) => Promise<Response>;
  updateUser: (request: Request, raw: string) => Promise<Response>;
};

/**
 * Builds the two interceptors against the same per-request auth factory the
 * mount uses. Auth configuration errors fail closed with the shared 503.
 */
export const createAccountAuthEndpoints = (
  getAuth: AuthForRequest,
): AccountAuthEndpoints => {
  const forward = async (request: Request, rawBody: string) => {
    try {
      return await getAuth(request).handler(forwarded(request, rawBody));
    } catch (error) {
      if (error instanceof AuthConfigurationError) {
        return authenticationNotConfiguredResponse();
      }

      throw error;
    }
  };

  const changePassword = (request: Request, raw: string) => {
    const parsed = parseChangePassword(raw);
    if (parsed instanceof Response) {
      return Promise.resolve(parsed);
    }

    // Rotation always revokes every other session; the response carries a
    // fresh session cookie for the device that changed the password.
    return forward(request, JSON.stringify(parsed.body));
  };

  const updateUser = (request: Request, raw: string) => {
    const parsed = parseUpdateUser(raw);
    if (parsed instanceof Response) {
      return Promise.resolve(parsed);
    }

    return forward(request, JSON.stringify(parsed.body));
  };

  return { changePassword, updateUser };
};
