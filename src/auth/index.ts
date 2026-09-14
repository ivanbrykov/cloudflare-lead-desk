import { type Env } from '@/db/repository';
import * as schema from '@/db/schema';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzle } from 'drizzle-orm/d1';

const encoder = new TextEncoder();

/**
 * Timing-safe comparison for the invite token. workerd extends WebCrypto
 * with `crypto.subtle.timingSafeEqual` (synchronous, throws on length
 * mismatch); the loop fallback covers runtimes that lack the extension.
 * Token length is not secret, so the length guard may exit early.
 */
const tokenMatches = (provided: string, expected: string): boolean => {
  const left = encoder.encode(provided);
  const right = encoder.encode(expected);
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(left, right);
  }

  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }

  return difference === 0;
};

// Built per app instance because the D1 binding only exists on the request
// environment. The Better Auth CLI loads ./cli.ts instead (no bindings are
// available there), so keep the options below in sync with that file.
export const createAuth = (environment: Env) => {
  // Production pins the origin to BETTER_AUTH_URL. Without it the wildcard
  // host allowlist must not be used, so authConfigured stays false and every
  // auth endpoint fails closed (503) instead of minting sessions.
  const authConfigured =
    environment.ENVIRONMENT !== 'production' ||
    Boolean(environment.BETTER_AUTH_URL);
  if (!authConfigured) {
    // eslint-disable-next-line no-console -- misconfiguration must be visible in Worker logs
    console.error(
      'BETTER_AUTH_URL is not set: Better Auth fails closed in production. Set BETTER_AUTH_URL to the public origin of this Worker.',
    );
  }

  return betterAuth({
    baseURL:
      environment.BETTER_AUTH_URL ??
      (environment.ENVIRONMENT === 'production'
        ? undefined
        : { allowedHosts: ['*'] }),
    database: drizzleAdapter(drizzle(environment.DB, { schema }), {
      provider: 'sqlite',
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (!authConfigured) {
          throw APIError.fromStatus(503, {
            code: 'authentication_not_configured',
            message:
              'Authentication is not configured on this deployment. Set BETTER_AUTH_URL.',
          });
        }

        if (context.path !== '/sign-up/email') {
          return;
        }

        // Registration is invite-only: the request must carry the invite
        // token in X-Setup-Token, compared against SETUP_TOKEN in constant
        // time. A missing/unset SETUP_TOKEN rejects every sign-up.
        const provided = context.getHeader('x-setup-token') ?? '';
        if (
          !environment.SETUP_TOKEN ||
          !tokenMatches(provided, environment.SETUP_TOKEN)
        ) {
          throw APIError.from('FORBIDDEN', {
            code: 'invite_token_required',
            message:
              'Registration is invite-only. A valid invite token is required.',
          });
        }
      }),
    },
    secret: environment.BETTER_AUTH_SECRET,
  });
};

export type Auth = ReturnType<typeof createAuth>;
