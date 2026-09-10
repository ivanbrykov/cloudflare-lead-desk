import { env } from 'cloudflare:workers';
import { createApp } from './api/app';
import type { Env } from './db/repository';

const workerEnv = env as unknown as Env;
const app = createApp(workerEnv).compile();
const API_PATHS = ['/v1/', '/openapi', '/health'];

export default {
  async fetch(request: Request): Promise<Response> {
    // Intake bodies are bounded to 65,536 actual bytes by the Elysia intake
    // route's get-stream-backed parse hook, so the entry forwards requests
    // untouched and performs no route matching of its own.
    const pathname = new URL(request.url).pathname;
    if (API_PATHS.some((path) => pathname === path || pathname.startsWith(path))) {
      return app.handle(request);
    }
    return workerEnv.ASSETS.fetch(request);
  },
};
