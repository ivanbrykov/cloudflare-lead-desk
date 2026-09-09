/**
 * Bounded raw-body read for POST /v1/intakes, applied at the Worker entry so
 * it runs BEFORE Elysia's automatic JSON parsing.
 *
 * The stream is read at most `MAX_INTAKE_BODY_BYTES + 1` chunks' worth and
 * cancelled as soon as the limit is exceeded, so neither a declared
 * Content-Length nor a missing one can make us buffer an unlimited body:
 * only the actual byte count decides. Allowed bodies are re-attached to a
 * fresh Request so the rest of the stack reads the body exactly once.
 */

export const MAX_INTAKE_BODY_BYTES = 65_536;

const INTAKE_PATH = '/v1/intakes';

export const limitIntakeBody = async (
  request: Request,
): Promise<Request | Response> => {
  if (request.method !== 'POST' || new URL(request.url).pathname !== INTAKE_PATH) {
    return request;
  }
  const body = request.body;
  if (!body) return request;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > MAX_INTAKE_BODY_BYTES) {
        return Response.json(
          {
            code: 'payload_too_large',
            message: `The intake request body must not exceed ${MAX_INTAKE_BODY_BYTES} bytes.`,
          },
          { status: 413 },
        );
      }
    }
  } finally {
    reader.releaseLock();
  }

  const headers = new Headers(request.headers);
  headers.set('Content-Length', String(total));
  return new Request(request, {
    body: new Blob(chunks as BlobPart[], { type: headers.get('Content-Type') ?? undefined }),
    headers,
  });
};
