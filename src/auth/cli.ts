import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/sqlite-proxy';

// CLI-only config used by `pnpm dlx @better-auth/cli@latest generate` to emit
// the auth tables (no D1 binding is available outside the Workers runtime).
// The runtime factory lives in ./index.ts; keep the options below in sync with
// it. The proxy callback is never invoked — schema generation runs no queries.
export const auth = betterAuth({
  database: drizzleAdapter(
    drizzle(async () => {
      throw new Error('CLI schema generation must not run queries.');
    }),
    { provider: 'sqlite' },
  ),
  emailAndPassword: { enabled: true },
});
