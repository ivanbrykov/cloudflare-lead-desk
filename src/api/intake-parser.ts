import { MaxBufferError, getStreamAsArrayBuffer } from 'get-stream';

/**
 * Policy: the largest raw intake body Lead Desk will accept, in ACTUAL BYTES,
 * measured before JSON decoding and before any domain write.
 */
export const MAX_INTAKE_BODY_BYTES = 65_536;

/**
 * Bounded intake-body reader for `POST /v1/intakes`, owned by the
 * `get-stream` library and invoked from the Elysia route `parse` hook.
 *
 * Because the hook belongs to the route (not to a Worker entry path check),
 * every accepted alias of the route — `/v1/intakes`, `/v1/intakes/`, and the
 * normalized `/v1/intakes/.` — reads the streamed body through the same
 * facility, with or without a declared `Content-Length`: only the actual byte
 * count decides.
 *
 * `getStreamAsArrayBuffer` enforces `maxBuffer` in bytes; when the limit is
 * exceeded it throws `MaxBufferError` and cancels the still-open input
 * stream. Its async iteration releases the reader lock on both the success
 * and the overflow path, so no chunks are buffered beyond the limit and the
 * stream resource is returned to the runtime instead of being re-wrapped in
 * a reconstructed Request.
 *
 * Integration notes:
 * - Elysia only invokes the hook for requests that carry a body and a
 *   Content-Type, and it runs the hook before the route handler, so an
 *   oversized body is rejected before token or idempotency checks.
 * - Only `application/json` bodies are decoded here. Any other content type
 *   returns `undefined` so Elysia applies its default parser and the route's
 *   previous behavior for those requests is preserved.
 * - A JSON syntax failure throws the ordinary `SyntaxError`, which Elysia
 *   wraps in its `ParseError` and maps to the existing 400 response, exactly
 *   as the framework's default JSON parser did.
 */
export const parseIntakeBody = async (
  context: { request: Request },
  contentType: string,
): Promise<unknown> => {
  if (contentType !== 'application/json' || !context.request.body) return undefined;
  const bytes = await getStreamAsArrayBuffer(context.request.body, {
    maxBuffer: MAX_INTAKE_BODY_BYTES,
  });
  return JSON.parse(new TextDecoder().decode(bytes));
};

/**
 * Error mapping for intake parse failures, invoked from the Elysia route
 * `error` hook.
 *
 * Elysia wraps whatever the parse hook throws in a `ParseError`; this maps
 * the `get-stream` `MaxBufferError` cause to the existing
 * `413 payload_too_large` response. The `MaxBufferError` instance carries
 * `bufferedData` with raw submitted bytes, so only its type is inspected
 * here — the error itself is never returned, logged, or stringified.
 *
 * Every other error returns `undefined` and keeps the framework's default
 * handling (400 for malformed JSON, unchanged for anything else).
 */
export const mapIntakeBodyError = (
  error: unknown,
  status: (code: number, response: unknown) => unknown,
): unknown => {
  if (error instanceof Error && error.cause instanceof MaxBufferError) {
    return status(413, {
      code: 'payload_too_large',
      message: `The intake request body must not exceed ${MAX_INTAKE_BODY_BYTES} bytes.`,
    });
  }
  return undefined;
};
