import { type Env } from '@/db/repository';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication is required.') {
    super(message);
  }
}

const HTTPS_PREFIX = /^https:\/\//u;

const jwtSetFor = (teamDomain: string) =>
  createRemoteJWKSet(
    new URL(
      `https://${teamDomain.replace(HTTPS_PREFIX, '')}/cdn-cgi/access/certs`,
    ),
  );

export const requireAccessIdentity = async (
  request: Request,
  environment: Env,
): Promise<string> => {
  if (environment.ENVIRONMENT !== 'production' && environment.DEV_ADMIN_EMAIL) {
    return environment.DEV_ADMIN_EMAIL;
  }

  if (!environment.ACCESS_AUD || !environment.ACCESS_TEAM_DOMAIN) {
    throw new UnauthorizedError('Cloudflare Access is not configured.');
  }

  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) {
    throw new UnauthorizedError();
  }

  const teamDomain = environment.ACCESS_TEAM_DOMAIN.replace(HTTPS_PREFIX, '');
  const { payload } = await jwtVerify(assertion, jwtSetFor(teamDomain), {
    audience: environment.ACCESS_AUD,
    issuer: `https://${teamDomain}`,
  });
  if (typeof payload.email !== 'string' || payload.email.length === 0) {
    throw new UnauthorizedError(
      'Cloudflare Access did not provide an email identity.',
    );
  }

  return payload.email;
};

export const bearerToken = (request: Request): null | string => {
  const value = request.headers.get('Authorization');
  if (!value?.startsWith('Bearer ')) {
    return null;
  }

  return value.slice('Bearer '.length).trim() || null;
};
