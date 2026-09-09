import { createApp } from './api/app';
import { limitIntakeBody } from './api/request-limit';
import type { Env } from './db/repository';

const API_PATHS = ['/v1/', '/openapi', '/health'];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Same bounded intake-body read as the deployed global-scope entry.
    const limited = await limitIntakeBody(request);
    if (limited instanceof Response) return limited;
    const pathname = new URL(request.url).pathname;
    if (API_PATHS.some((path) => pathname === path || pathname.startsWith(path))) {
      return createApp(env).handle(limited);
    }
    return env.ASSETS.fetch(limited);
  },
};
