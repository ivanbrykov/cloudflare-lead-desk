import { type createApp } from '@/api/app';
import { quietFetch } from '@/lib/quiet-fetch';
import { treaty } from '@elysia/eden';

type App = ReturnType<typeof createApp>;

// Eden keeps a typed client available to TypeScript adopters. The thin fetch
// wrapper below deliberately keeps UI requests easy to inspect in DevTools.
// The transport is `quietFetch`: Chromium writes a console error for every
// non-2xx response the renderer observes, and the UI legitimately renders
// failure states (expired invitation, failed list fetch), so requests run on
// the worker transport that keeps those statuses out of the page console.
export const eden = treaty<App>(window.location.origin, {
  // Route Eden traffic through the worker-backed transport for the same reason
  // `request` does: non-2xx responses otherwise land in the page console.
  fetcher: quietFetch,
});

type ApiEnvelope<T> = { data: T };

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const request = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const response = await quietFetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json()) as (ApiEnvelope<T> | T) & {
    message?: string;
  };
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      payload.message ?? 'Request failed.',
    );
  }

  // The Elysia API wraps successful payloads in a `{ data }` envelope. Some
  // browser mocks (and proxies) serve the bare payload instead. Unwrap the
  // envelope when it is present, otherwise pass the payload through, so the
  // UI works against both shapes. Real-API behavior is unchanged because the
  // backend always envelopes.
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'data' in payload
  ) {
    return (payload as ApiEnvelope<T>).data;
  }

  return payload as T;
};
