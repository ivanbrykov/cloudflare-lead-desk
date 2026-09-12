import { getStreamAsArrayBuffer, MaxBufferError } from 'get-stream';

export const MAX_INTAKE_BODY_BYTES = 65_536;

class UnsupportedIntakeMediaType extends Error {}

// Elysia owns route matching; get-stream owns byte counting and cancellation.
// Never fall through to an unbounded framework reader for another media type.
export const parseIntakeBody = async (
  { request }: { request: Request },
  contentType: string,
): Promise<unknown> => {
  if (!request.body) {
    throw new SyntaxError('An intake JSON body is required.');
  }

  const bytes = await getStreamAsArrayBuffer(request.body, {
    maxBuffer: MAX_INTAKE_BODY_BYTES,
  });
  if (contentType.trim().toLowerCase() !== 'application/json') {
    throw new UnsupportedIntakeMediaType();
  }

  return JSON.parse(new TextDecoder().decode(bytes));
};

// Elysia wraps parser errors in ParseError. Only inspect the cause's type:
// MaxBufferError.bufferedData can contain contact data and must not be logged.
export const mapIntakeBodyError = (
  error: unknown,
  status: (code: number, response: unknown) => unknown,
): unknown => {
  if (!(error instanceof Error)) {
    return undefined;
  }

  if (error.cause instanceof MaxBufferError) {
    return status(413, {
      code: 'payload_too_large',
      message: `The intake request body must not exceed ${MAX_INTAKE_BODY_BYTES} bytes.`,
    });
  }

  if (error.cause instanceof UnsupportedIntakeMediaType) {
    return status(415, {
      code: 'unsupported_media_type',
      message: 'Use Content-Type: application/json for intake requests.',
    });
  }

  // Includes the framework's normal 400 handling for malformed/empty JSON.
  return undefined;
};
