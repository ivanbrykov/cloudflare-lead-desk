import { type Auth } from '@/auth';
import { type Env } from '@/db/repository';

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

  return session.user.email;
};

export const bearerToken = (request: Request): null | string => {
  const value = request.headers.get('Authorization');
  if (!value?.startsWith('Bearer ')) {
    return null;
  }

  return value.slice('Bearer '.length).trim() || null;
};
