import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '@/db/repository';

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication is required.') {
    super(message);
  }
}

const jwtSetFor = (teamDomain: string) =>
  createRemoteJWKSet(
    new URL(`https://${teamDomain.replace(/^https:\/\//, '')}/cdn-cgi/access/certs`),
  );

export const requireAccessIdentity = async (
  request: Request,
  env: Env,
): Promise<string> => {
  if (env.ENVIRONMENT !== 'production' && env.DEV_ADMIN_EMAIL) {
    return env.DEV_ADMIN_EMAIL;
  }
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) {
    throw new UnauthorizedError('Cloudflare Access is not configured.');
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) throw new UnauthorizedError();
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/^https:\/\//, '');
  const { payload } = await jwtVerify(assertion, jwtSetFor(teamDomain), {
    audience: env.ACCESS_AUD,
    issuer: `https://${teamDomain}`,
  });
  if (typeof payload.email !== 'string' || payload.email.length === 0) {
    throw new UnauthorizedError('Cloudflare Access did not provide an email identity.');
  }
  return payload.email;
};

export const bearerToken = (request: Request): string | null => {
  const value = request.headers.get('Authorization');
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim() || null;
};
