/**
 * Invitation-only sign-up boundary (stage s4).
 *
 * Intercepts POST /api/auth/sign-up/email before Better Auth's native
 * sign-up handler: validates the normalized bounded fields, enforces the
 * trusted Origin header and a same-origin/relative callbackURL, resolves
 * the grant from the X-Setup-Token header (bootstrap SETUP_TOKEN or a
 * one-time staff invite), creates the account through the atomic s2
 * redemption primitive, and issues the session through Better Auth's own
 * sign-in handler. No custom session cookie or password crypto: Better
 * Auth's helpers do both.
 */
import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
  matchesBootstrapToken,
  resolveAuthOrigin,
} from '@/auth';
import {
  redeemRegistration,
  RegistrationError,
  type RegistrationGrant,
} from '@/auth/registration-repository';
import {
  availableStaffInviteGrant,
  type Env,
  isBootstrapGrantAvailable,
} from '@/db/repository';
import { hashPassword } from 'better-auth/crypto';

const NAME_MAX = 200;
const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 255;

const errorResponse = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status });

/**
 * Bounded RFC 5321 dot-atom address check: at most 254 characters total,
 * local part at most 64, dot-separated labels of 1-63 characters, ASCII,
 * lowercase.
 */
const isBoundedEmail = (email: string): boolean => {
  if (email.length === 0 || email.length > EMAIL_MAX) {
    return false;
  }

  const at = email.lastIndexOf('@');
  if (at < 1) {
    return false;
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > LOCAL_MAX) {
    return false;
  }

  // dot-atom local part: atext with single dots, never leading/trailing.
  if (!/^[\da-z](?:[\d%+._a-z-]*[\da-z])?$/u.test(local)) {
    return false;
  }

  if (local.includes('..')) {
    return false;
  }

  for (const label of domain.split('.')) {
    if (label.length === 0 || label.length > 63) {
      return false;
    }

    if (!/^[\da-z](?:[\da-z-]*[\da-z])?$/u.test(label)) {
      return false;
    }
  }

  return true;
};

type ParsedSignUpFields = {
  callbackURL?: string;
  password: string;
};

const parsePasswordAndCallbackURL = (
  body: Record<string, unknown>,
  origin: string,
): ParsedSignUpFields | Response => {
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < PASSWORD_MIN) {
    return errorResponse(
      422,
      'validation_error',
      `password must be at least ${PASSWORD_MIN} characters.`,
    );
  }

  if (password.length > PASSWORD_MAX) {
    return errorResponse(
      422,
      'validation_error',
      `password must be at most ${PASSWORD_MAX} characters.`,
    );
  }

  if (password.trim() === '') {
    return errorResponse(
      422,
      'validation_error',
      'password must not consist only of whitespace.',
    );
  }

  // callbackURL: absent, relative path, or same-origin absolute URL.
  let callbackURL: string | undefined;
  const rawCallback = body.callbackURL;
  if (rawCallback !== undefined) {
    if (typeof rawCallback !== 'string' || rawCallback === '') {
      return errorResponse(
        422,
        'validation_error',
        'callbackURL must be a relative path or a same-origin URL.',
      );
    }

    if (rawCallback.startsWith('/')) {
      callbackURL = rawCallback;
    } else {
      let candidate: URL;
      try {
        candidate = new URL(rawCallback);
      } catch {
        return errorResponse(
          422,
          'validation_error',
          'callbackURL must be a relative path or a same-origin URL.',
        );
      }

      if (candidate.origin !== origin) {
        return errorResponse(
          403,
          'forbidden',
          'callbackURL must be on the trusted origin.',
        );
      }

      callbackURL = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    }
  }

  return { callbackURL, password };
};

export const handleInvitationSignUp = async (
  environment: Env,
  request: Request,
  getAuth: (request: Request) => Auth,
): Promise<Response> => {
  // Fail closed before any validation or write when authentication is not
  // configured (unresolvable origin or a missing/weak production secret).
  let auth: Auth;
  let origin: string;
  try {
    origin = resolveAuthOrigin(environment, request);
    auth = getAuth(request);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return authenticationNotConfiguredResponse();
    }

    throw error;
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(
      422,
      'validation_error',
      'The request body must be a JSON object.',
    );
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return errorResponse(
      422,
      'validation_error',
      'The request body must be a JSON object.',
    );
  }

  const body = payload as Record<string, unknown>;

  // The Origin header, when present, must be exactly the trusted origin;
  // requests without one (non-browser callers) are allowed, matching the
  // /api/invites/validate boundary.
  const originHeader = request.headers.get('Origin');
  if (originHeader !== null && originHeader !== origin) {
    return errorResponse(
      403,
      'forbidden',
      'The request origin is not trusted.',
    );
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') {
    return errorResponse(422, 'validation_error', 'name is required.');
  }

  if (name.length > NAME_MAX) {
    return errorResponse(
      422,
      'validation_error',
      `name must be at most ${NAME_MAX} characters.`,
    );
  }

  const email =
    typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isBoundedEmail(email)) {
    return errorResponse(
      422,
      'validation_error',
      `email must be a valid address (at most ${EMAIL_MAX} characters, local part at most ${LOCAL_MAX}).`,
    );
  }

  const fields = parsePasswordAndCallbackURL(body, origin);
  if (fields instanceof Response) {
    return fields;
  }

  const { callbackURL, password } = fields;

  // Grant resolution: the bootstrap SETUP_TOKEN (constant-time compare) or
  // a one-time staff invite. A missing, unknown, or unavailable grant all
  // fail closed with the same 403 before any write.
  const providedToken = request.headers.get('x-setup-token') ?? '';
  let grant: RegistrationGrant | undefined;
  if (providedToken !== '') {
    if (matchesBootstrapToken(environment, providedToken)) {
      grant = (await isBootstrapGrantAvailable(environment))
        ? { kind: 'bootstrap' }
        : undefined;
    } else {
      grant = await availableStaffInviteGrant(environment, providedToken);
    }
  }

  if (grant === undefined) {
    return errorResponse(
      403,
      'invite_unavailable',
      'Invitation is unavailable.',
    );
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    await redeemRegistration(environment.DB, {
      accountId: userId,
      email,
      grant,
      name,
      now: Date.now(),
      passwordHash,
      userId,
    });
  } catch (error) {
    if (error instanceof RegistrationError) {
      if (error.code === 'email_exists') {
        return errorResponse(
          409,
          'email_exists',
          'An account with this email already exists.',
        );
      }

      if (error.code === 'invite_unavailable') {
        return errorResponse(
          403,
          'invite_unavailable',
          'Invitation is unavailable.',
        );
      }

      return errorResponse(
        500,
        'persistence_error',
        'The account could not be created.',
      );
    }

    throw error;
  }

  // The account is committed: issue the session through Better Auth's own
  // sign-in handler. Its response (including the session cookie) is
  // returned verbatim, so no custom session cookie crypto is involved.
  try {
    const signIn = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        body: JSON.stringify({
          email,
          ...(callbackURL === undefined ? {} : { callbackURL }),
          password,
        }),
        headers: {
          'content-type': 'application/json',
          origin,
        },
        method: 'POST',
      }),
    );
    if (signIn.ok) {
      return signIn;
    }
  } catch {
    // Fall through to the recoverable account-created response below.
  }

  // The account exists but session issuance failed: a server-side 5xx,
  // never 200, with the exact recovery step (sign in again).
  return Response.json(
    {
      accountCreated: true,
      code: 'session_unavailable',
      message:
        'Your account was created. Sign in at /api/auth/sign-in/email with your email and password to obtain a session.',
    },
    { status: 502 },
  );
};
