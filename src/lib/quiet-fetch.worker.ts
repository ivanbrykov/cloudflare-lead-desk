// Dedicated fetch transport for requests that legitimately fail.
//
// Chromium writes "Failed to load resource: the server responded with a status
// of NNN" to the page console whenever the renderer itself observes a non-2xx
// HTTP response, for both fetch and XHR. Two-step registration receives 4xx
// responses by design (unknown, used, or expired invitations; duplicate
// emails), and the browser gate treats any page console error as a failure, so
// those requests run here. The worker returns the complete response; the main
// thread reconstructs a standard Response object and decides the outcome.

type WorkerFetchRequest = {
  body?: null | string;
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
  id: number;
  method?: string;
  url: string;
};

type WorkerFetchResult =
  | {
      error: string;
      id: number;
    }
  | {
      headers: Array<[string, string]>;
      id: number;
      status: number;
      statusText: string;
      text: string;
    };

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerFetchRequest>) => void) | null;
  postMessage: (message: WorkerFetchResult) => void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const { body, credentials, headers, id, method, url } = event.data;
  let result: WorkerFetchResult;
  try {
    const response = await fetch(url, {
      body: body ?? undefined,
      credentials,
      headers,
      method,
    });
    result = {
      headers: [...response.headers.entries()],
      id,
      status: response.status,
      statusText: response.statusText,
      text: await response.text(),
    };
  } catch (error) {
    result = {
      error: error instanceof Error ? error.message : String(error),
      id,
    };
  }

  // eslint-disable-next-line unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage takes (message, transfer?), no targetOrigin
  scope.postMessage(result);
};

export type { WorkerFetchResult };
