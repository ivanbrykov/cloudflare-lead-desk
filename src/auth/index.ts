import { type Env } from '@/db/repository';
import * as schema from '@/db/schema';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzle } from 'drizzle-orm/d1';

const encoder = new TextEncoder();

const PRODUCTION_PLACEHOLDER_SECRETS = new Set([
  'replace-with-openssl-rand-base64-32',
  'replace-with-openssl-rand-hex-32',
]);

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

export const authenticationNotConfiguredResponse = () =>
  Response.json(
    {
      code: 'authentication_not_configured',
      message: 'Authentication is not configured on this deployment.',
    },
    { status: 503 },
  );

const isProduction = (environment: Env) =>
  environment.ENVIRONMENT === 'production';

const configuredValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

/**
 * Resolves the public origin without consulting request headers. On Workers,
 * request.url is produced by the incoming route, whereas Host and forwarded
 * headers are client-controlled inputs to this application.
 */
export const resolveAuthOrigin = (
  environment: Env,
  request: Request,
): string => {
  const override = configuredValue(environment.BETTER_AUTH_URL);
  const candidate = override ?? request.url;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AuthConfigurationError(
      override
        ? 'BETTER_AUTH_URL must be an absolute origin URL.'
        : 'The request URL does not contain a valid origin.',
    );
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.host.includes('*') ||
    url.host.includes('?') ||
    (override &&
      (url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash)) ||
    url.origin === 'null'
  ) {
    throw new AuthConfigurationError(
      override
        ? 'BETTER_AUTH_URL must be an absolute origin without a path, query, or fragment.'
        : 'The request URL does not contain a valid HTTP origin.',
    );
  }

  if (isProduction(environment) && url.protocol !== 'https:') {
    throw new AuthConfigurationError(
      'Authentication requires an HTTPS origin in production.',
    );
  }

  return url.origin;
};

const assertProductionSecrets = (environment: Env) => {
  if (!isProduction(environment)) {
    return;
  }

  const secret = configuredValue(environment.BETTER_AUTH_SECRET);
  if (
    !secret ||
    secret.length < 32 ||
    PRODUCTION_PLACEHOLDER_SECRETS.has(secret)
  ) {
    throw new AuthConfigurationError(
      'BETTER_AUTH_SECRET must be a non-placeholder secret of at least 32 characters in production.',
    );
  }
};

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

/**
 * The bootstrap invite token for this deployment, if a usable one is
 * configured: SETUP_TOKEN must be set, and in production it must be at
 * least 32 characters after trimming and not a documented placeholder.
 */
export const bootstrapToken = (environment: Env): string | undefined => {
  const setupToken = environment.SETUP_TOKEN;
  if (!setupToken) {
    return undefined;
  }

  if (
    isProduction(environment) &&
    (setupToken.trim().length < 32 ||
      PRODUCTION_PLACEHOLDER_SECRETS.has(setupToken.trim()))
  ) {
    return undefined;
  }

  return setupToken;
};

/**
 * Constant-time check of a provided value against the deployment's
 * bootstrap token (SETUP_TOKEN). False whenever no usable bootstrap token
 * is configured.
 */
export const matchesBootstrapToken = (
  environment: Env,
  provided: string,
): boolean => {
  const expected = bootstrapToken(environment);
  return expected !== undefined && tokenMatches(provided, expected);
};

// Constructed for each authentication operation. The Worker module can keep
// the Elysia app compiled globally, but it must never retain a request-derived
// Better Auth origin across requests. The CLI loads ./cli.ts instead (no
// bindings are available there), so keep the options below in sync with it.
export const createAuth = (environment: Env, request: Request) => {
  const origin = resolveAuthOrigin(environment, request);
  assertProductionSecrets(environment);

  return betterAuth({
    advanced: {
      // Keep this explicit: the resolved origin above is intentionally the
      // only authority; x-forwarded-host and x-forwarded-proto stay ignored.
      trustedProxyHeaders: false,
    },
    // Both Better Auth's base URL and its CSRF allowlist contain one exact
    // origin. Do not use allowedHosts: it resolves Host / forwarded headers.
    baseURL: origin,
    database: drizzleAdapter(drizzle(environment.DB, { schema }), {
      provider: 'sqlite',
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== '/sign-up/email') {
          return;
        }

        // Defense in depth: the invitation-only boundary (see
        // src/api/app.ts) intercepts POST /api/auth/sign-up/email before
        // it reaches Better Auth. Any sign-up that reaches this handler
        // anyway (for example through a path alias) must still be
        // rejected: this deployment has no open sign-up.
        throw APIError.from('FORBIDDEN', {
          code: 'invite_unavailable',
          message: 'Registration requires an available invitation.',
        });
      }),
    },
    secret: environment.BETTER_AUTH_SECRET,
  });
};

export type Auth = ReturnType<typeof createAuth>;
