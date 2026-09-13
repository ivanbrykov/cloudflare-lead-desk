import { type Env } from '@/db/repository';
import * as schema from '@/db/schema';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/d1';

// Built per app instance because the D1 binding only exists on the request
// environment. The Better Auth CLI loads ./cli.ts instead (no bindings are
// available there), so keep the options below in sync with that file.
export const createAuth = (environment: Env) =>
  betterAuth({
    // Self-hosted deployments run on arbitrary hostnames, so derive the
    // origin from the request unless an operator pins BETTER_AUTH_URL.
    baseURL: environment.BETTER_AUTH_URL ?? { allowedHosts: ['*'] },
    database: drizzleAdapter(drizzle(environment.DB, { schema }), {
      provider: 'sqlite',
      schema,
    }),
    emailAndPassword: {
      disableSignUp: environment.DISABLE_SIGN_UP === 'true',
      enabled: true,
    },
    secret: environment.BETTER_AUTH_SECRET,
  });

export type Auth = ReturnType<typeof createAuth>;
