import { env } from 'cloudflare:workers';
import { createApp } from './api/app';
import { limitIntakeBody } from './api/request-limit';
import type { Env } from './db/repository';

const workerEnv = env as unknown as Env;
const app = createApp(workerEnv).compile();
const API_PATHS = ['/v1/', '/openapi', '/health'];

export default {
  async fetch(request: Request): Promise<Response> {
    // Intake bodies are bounded to 65,536 actual bytes BEFORE the framework
    // parses JSON; every other route is forwarded untouched.
    const limited = await limitIntakeBody(request);
    if (limited instanceof Response) return limited;
    const pathname = new URL(request.url).pathname;
    if (API_PATHS.some((path) => pathname === path || pathname.startsWith(path))) {
      return app.handle(limited);
    }
    return workerEnv.ASSETS.fetch(limited);
  },
};
