import { createAuthClient } from 'better-auth/react';

// Same-origin: the Worker serves both the SPA and /api/auth, so no baseURL.
export const authClient = createAuthClient();

export const { signIn, signOut, signUp, useSession } = authClient;
