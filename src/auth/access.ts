import { type Auth } from '@/auth';
import { type Env, getStaffAccountByEmail } from '@/db/repository';

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication is required.') {
    super(message);
  }
}

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

  // Stage s4: registration is invitation-only, so every enabled Better Auth
  // account belongs to staff. There is no email allowlist to enforce.
  // Stage s5: durable revocation. The session row is deleted when an
  // account is disabled, but protected routes also consult the DB account
  // state directly, so a stale session can never authorize a disabled
  // account even if the row were momentarily still observable.
  const account = await getStaffAccountByEmail(
    environment,
    session.user.email.toLowerCase(),
  );
  if (account === undefined || account.disabledAt !== null) {
    throw new UnauthorizedError();
  }

  return session.user.email;
};

export const bearerToken = (request: Request): null | string => {
  const value = request.headers.get('Authorization');
  if (!value?.startsWith('Bearer ')) {
    return null;
  }

  return value.slice('Bearer '.length).trim() || null;
};
