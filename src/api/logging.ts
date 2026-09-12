/**
 * Structured request logging for the Lead Desk API.
 *
 * Emits one JSON line per API request. Lines are emitted synchronously
 * before the response is returned: a Workers isolate may be suspended as
 * soon as the response is sent, so post-response callbacks (including
 * Elysia's `onAfterResponse` hook) are not a reliable place to log.
 *
 * Levels: 5xx statuses and logged failures use `console.error`, everything
 * else uses `console.log`.
 *
 * Privacy: lines carry only the method, the URL pathname (never the query
 * string — e.g. `/v1/contacts?query=` search terms are contact data), the
 * final status, the duration, and for failures the error class (plus the
 * error message for command defects). Never headers, bodies, tokens, query
 * strings, stacks, or SQL with bound values: persistence failures log the
 * cause's class only, because a database error message can embed SQL with
 * bound values.
 */

const requestStarts = new WeakMap<object, number>();

const roundMs = (value: number): number => Math.round(value * 100) / 100;

/**
 * Record the start time for a request. Called once per request at the API boundary.
 */
export const markRequestStart = (request: Request): void => {
  requestStarts.set(request, performance.now());
};

const durationMs = (request: Request): number => {
  const started = requestStarts.get(request);
  return started === undefined
    ? 0
    : Math.max(0, roundMs(performance.now() - started));
};

type FailureFields = {
  errorCauseClass?: string;
  errorClass: string;
  errorMessage?: string;
};

/**
 * Emit one structured JSON line for the request.
 *
 * `status` must be the final HTTP status of the response. When `failure` is
 * provided the line is a failure line (`event: "request.failure"`) carrying
 * the error class/message instead of relying on the status alone; it is
 * still emitted at the level chosen by `status`.
 */
export const logRequest = (
  request: Request,
  status: number,
  failure?: FailureFields,
): void => {
  const line = JSON.stringify({
    durationMs: durationMs(request),
    event: failure ? 'request.failure' : 'request',
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    ...failure,
  });
  if (status >= 500) {
    console.error(line);
  } else {
    console.log(line);
  }
};
