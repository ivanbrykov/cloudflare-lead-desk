// fetch() replacement that performs the network request in a dedicated worker
// so non-2xx responses never reach the page console. Chromium logs every
// error-status response observed by the renderer ("Failed to load resource:
// ...") as a page console error; see quiet-fetch.worker.ts for details.
import { type WorkerFetchResult } from './quiet-fetch.worker';

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (response: Response) => void;
};

let nextId = 0;
let worker: null | Worker = null;
const pending = new Map<number, PendingRequest>();

const toHeaderRecord = (
  headers: HeadersInit | undefined,
): Record<string, string> | undefined => {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
};

const ensureWorker = (): Worker => {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL('quiet-fetch.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<WorkerFetchResult>) => {
    const { id } = event.data;
    const entry = pending.get(id);
    if (!entry) {
      return;
    }

    pending.delete(id);
    if ('error' in event.data) {
      entry.reject(new Error(event.data.error));
      return;
    }

    const isNullBody =
      event.data.status === 204 ||
      event.data.status === 205 ||
      event.data.status === 304;
    entry.resolve(
      new Response(isNullBody ? null : event.data.text, {
        headers: event.data.headers,
        status: event.data.status,
        statusText: event.data.statusText,
      }),
    );
  };

  worker.onerror = () => {
    const failure = new Error('Quiet fetch worker is unavailable');
    for (const entry of pending.values()) {
      entry.reject(failure);
    }

    pending.clear();
  };

  return worker;
};

export const quietFetch = (
  input: Request | string | URL,
  init?: RequestInit,
): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    // better-fetch passes `body: null` for bodyless requests (e.g. GET); the
    // fetch spec treats a null body as "no body", so normalize it here.
    const body = init?.body ?? undefined;
    if (body !== undefined && typeof body !== 'string') {
      reject(new Error('quietFetch supports string request bodies only'));
      return;
    }

    const id = nextId;
    nextId += 1;
    pending.set(id, { reject, resolve });
    const payload = {
      body,
      credentials: init?.credentials,
      headers: toHeaderRecord(init?.headers),
      id,
      method: init?.method,
      url:
        input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : input,
    };
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage takes (message, transfer?), no targetOrigin
    ensureWorker().postMessage(payload);
  });
