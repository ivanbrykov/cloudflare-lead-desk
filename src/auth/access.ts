import { type Auth } from '@/auth';
import { type Env } from '@/db/repository';

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication is required.') {
    super(message);
  }
}

const parseStaffAllowlist = (allowlist: string | undefined): string[] =>
  (allowlist ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');

/**
 * The single staff allowlist check: an email is staff when it matches an
 * entry of STAFF_EMAILS after trimming whitespace and ignoring case.
 */
export const isStaffEmail = (
  email: string,
  allowlist: string | undefined,
): boolean => {
  const normalized = email.trim().toLowerCase();
  return (
    normalized !== '' && parseStaffAllowlist(allowlist).includes(normalized)
  );
};

export const requireSessionIdentity = async (
  request: Request,
  auth: Auth,
  environment: Env,
): Promise<string> => {
  // Development/test-only bypass so local runs and the Miniflare D1 suites do
  // not need a real session. Production always requires a Better Auth session.
  if (environment.ENVIRONMENT !== 'production' && environment.DEV_ADMIN_EMAIL) {
    return environment.DEV_ADMIN_EMAIL;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw new UnauthorizedError();
  }

  const email = session.user.email;
  // A configured allowlist is the staff gate: in production a session is
  // honored only for an allowlisted email, and an explicitly empty
  // allowlist fails closed instead of letting every session through. An
  // UNSET allowlist is bootstrap mode: the deployment has no staff roster
  // yet, so every authenticated session belongs to staff (registration
  // stays gated by SETUP_TOKEN).
  if (
    environment.ENVIRONMENT === 'production' &&
    environment.STAFF_EMAILS !== undefined &&
    !isStaffEmail(email, environment.STAFF_EMAILS)
  ) {
    throw new UnauthorizedError(
      'This account is not authorized to use this deployment.',
    );
  }

  return email;
};

export const bearerToken = (request: Request): null | string => {
  const value = request.headers.get('Authorization');
  if (!value?.startsWith('Bearer ')) {
    return null;
  }

  return value.slice('Bearer '.length).trim() || null;
};
