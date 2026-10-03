import { quietFetch } from './quiet-fetch';
import { createAuthClient } from 'better-auth/react';

// Same-origin: the Worker serves both the SPA and /api/auth, so no baseURL.
// Auth requests (including expected 4xx setup-token failures) run through a
// dedicated worker transport so error statuses stay out of the page console.
export const authClient = createAuthClient({
  fetchOptions: { customFetchImpl: quietFetch },
});

export const { signIn, signOut, signUp, useSession } = authClient;

// Account management: name updates and password rotation go through Better
// Auth's own endpoints (validated server-side by the /api/auth boundary).
export const { changePassword, updateUser } = authClient;
