import { type createApp } from '@/api/app';
import { treaty } from '@elysia/eden';

type App = ReturnType<typeof createApp>;

// Eden keeps a typed client available to TypeScript adopters. The thin fetch
// wrapper below deliberately keeps UI requests easy to inspect in DevTools.
export const eden = treaty<App>(window.location.origin);

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
  const response = await fetch(path, {
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

  const payload = (await response.json()) as ApiEnvelope<T> & {
    message?: string;
  };
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      payload.message ?? 'Request failed.',
    );
  }

  return payload.data;
};
