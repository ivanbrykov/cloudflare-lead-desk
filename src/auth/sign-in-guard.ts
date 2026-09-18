/**
 * Disabled-account sign-in boundary (stage s5).
 *
 * Better Auth verifies credentials and issues a session without consulting
 * any durable account state, so the /api/auth mount intercepts
 * POST /api/auth/sign-in/email and consults the DB account state FIRST. A
 * known, disabled account is rejected with 403 account_disabled before
 * Better Auth runs; every other request is forwarded to Better Auth
 * untouched (raw body re-attached, since reading it consumed the stream),
 * preserving Better Auth's own validation, CSRF, and error responses.
 *
 * Like the invitation sign-up boundary, the deployment's auth
 * configuration is resolved up front: an unresolvable origin or a
 * missing/weak production secret fails closed with 503
 * authentication_not_configured instead of leaking an unhandled error.
 */
import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
} from '@/auth';
import { type Env, getStaffAccountByEmail } from '@/db/repository';

const errorResponse = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status });

export const handleDisabledAccountSignIn = async (
  environment: Env,
  request: Request,
  getAuth: (request: Request) => Auth,
): Promise<Response> => {
  // Fail closed before any lookup or write when authentication is not
  // configured (unresolvable origin or a missing/weak production secret).
  let auth: Auth;
  try {
    auth = getAuth(request);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return authenticationNotConfiguredResponse();
    }

    throw error;
  }

  const rawBody = await request.text();
  let email: string | undefined;
  try {
    const payload: unknown = JSON.parse(rawBody);
    if (
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload)
    ) {
      const candidate = (payload as Record<string, unknown>).email;
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        email = candidate.trim().toLowerCase();
      }
    }
  } catch {
    // Not a JSON body: Better Auth reports its own validation error.
  }

  if (email !== undefined) {
    const account = await getStaffAccountByEmail(environment, email);
    if (account !== undefined && account.disabledAt !== null) {
      return errorResponse(
        403,
        'account_disabled',
        'This account has been disabled. Contact an administrator.',
      );
    }
  }

  const url = new URL(request.url);
  url.pathname = `/api/auth${url.pathname}`;
  const forwarded = new Request(url, {
    body: rawBody,
    headers: request.headers,
    method: request.method,
  });
  return auth.handler(forwarded);
};
