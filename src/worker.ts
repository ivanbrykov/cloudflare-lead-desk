import { createApp } from './api/app';
import type { Env } from './db/repository';

const API_PATHS = ['/v1/', '/openapi', '/health'];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (API_PATHS.some((path) => pathname === path || pathname.startsWith(path))) {
      return createApp(env).handle(request);
    }
    return env.ASSETS.fetch(request);
  },
};
