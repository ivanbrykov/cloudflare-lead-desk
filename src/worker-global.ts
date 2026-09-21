import { createApp } from './api/app';
import { logRequest, markRequestStart } from './api/logging';
import { type Env as Environment } from './db/repository';
import { env } from 'cloudflare:workers';

const workerEnvironment = env as unknown as Environment;
const app = createApp(workerEnvironment).compile();
const API_PATHS = [
  '/v1/',
  '/api/auth/',
  '/api/invites/',
  '/openapi',
  '/health',
];

export default {
  async fetch(request: Request): Promise<Response> {
    // Intake bodies are bounded to 65,536 actual bytes by the Elysia intake
    // route's get-stream-backed parse hook, so the entry forwards requests
    // untouched and performs no route matching of its own.
    const pathname = new URL(request.url).pathname;
    if (
      API_PATHS.some((path) => pathname === path || pathname.startsWith(path))
    ) {
      // One structured JSON line per API request, emitted before the
      // response is returned so it survives isolate suspension. See
      // src/api/logging.ts for the fields and the privacy rules.
      markRequestStart(request);
      let response: Response;
      try {
        response = await app.handle(request);
      } catch (error) {
        logRequest(request, 500, {
          errorClass:
            error instanceof Error
              ? error.name || error.constructor.name
              : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      logRequest(request, response.status);
      return response;
    }

    return workerEnvironment.ASSETS.fetch(request);
  },
};
