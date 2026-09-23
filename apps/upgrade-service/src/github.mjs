import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createPrivateKey, sign } from 'node:crypto';

const upstream = 'ivanbrykov/cloudflare-lead-desk';
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/u;

const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export class OAuthExchangeError extends Error {
  constructor(kind, upstreamStatus) {
    super('GitHub OAuth exchange failed');
    this.name = 'OAuthExchangeError';
    this.kind = kind;
    this.upstreamStatus = upstreamStatus;
  }
}

export const createAppJwt = async (appId, privateKey) => {
  assert(/^\d+$/u.test(String(appId)), 'Invalid GitHub App ID');
  const now = Math.floor(Date.now() / 1_000);
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ exp: now + 540, iat: now - 30, iss: String(appId) })}`;
  let signature;
  try {
    signature = sign(
      'RSA-SHA256',
      Buffer.from(payload),
      createPrivateKey(privateKey.replaceAll('\\n', '\n')),
    ).toString('base64url');
  } catch {
    throw new Error('App JWT signing failed');
  }

  return `${payload}.${signature}`;
};

const github = async (
  path,
  { body, fetchImpl = globalThis.fetch, method = 'GET', token },
) => {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'lead-desk-upgrade',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    method,
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  assert(contentLength <= 1_000_000, 'GitHub API response too large');
  const value = await response.text();
  assert(value.length <= 1_000_000, 'GitHub API response too large');
  return JSON.parse(value);
};

export const exchangeUserCode = async (
  { clientId, clientSecret, code, codeVerifier, redirectUri },
  fetchImpl = globalThis.fetch,
) => {
  let signal;
  try {
    signal = globalThis.AbortSignal.timeout(15_000);
  } catch {
    throw new OAuthExchangeError('oauth_timeout_signal');
  }

  let response;
  try {
    response = await fetchImpl('https://github.com/login/oauth/access_token', {
      body: new globalThis.URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
      signal,
    });
  } catch (error) {
    throw new OAuthExchangeError(
      error?.name === 'TimeoutError'
        ? 'oauth_transport_timeout'
        : 'oauth_transport_error',
    );
  }

  if (!response.ok) {
    throw new OAuthExchangeError('oauth_http', response.status);
  }

  let value;
  try {
    value = await response.json();
  } catch {
    throw new OAuthExchangeError('oauth_response_json');
  }

  if (typeof value?.access_token !== 'string' || !value.access_token) {
    const known = new Set([
      'bad_verification_code',
      'incorrect_client_credentials',
      'redirect_uri_mismatch',
      'unverified_user_email',
    ]);
    const reason = known.has(value?.error) ? value.error : 'unknown';
    throw new OAuthExchangeError(`oauth_response_${reason}`);
  }

  return value.access_token;
};

export const getUser = async (token, fetchImpl) =>
  github('/user', { fetchImpl, token });

export const listUserRepositories = async (token, fetchImpl) => {
  const installations = await github('/user/installations?per_page=100', {
    fetchImpl,
    token,
  });
  assert(
    installations.total_count <= 100,
    'Too many App installations; narrow App access before upgrading',
  );
  const repositories = [];
  for (const installation of installations.installations) {
    const page = await github(
      `/user/installations/${installation.id}/repositories?per_page=100`,
      { fetchImpl, token },
    );
    assert(
      page.total_count <= 100,
      'Too many repositories in one installation; select specific repositories',
    );
    repositories.push(...page.repositories);
  }

  return repositories.filter(
    (repository) =>
      repositoryPattern.test(repository.full_name) &&
      repository.full_name !== upstream,
  );
};

export const verifyUpgradeTarget = async (
  { appId, privateKey, repository, user, userToken },
  fetchImpl,
) => {
  assert(repositoryPattern.test(repository), 'Invalid repository');
  assert.notEqual(repository, upstream, 'Cannot upgrade the source repository');
  const available = await listUserRepositories(userToken, fetchImpl);
  const selected = available.find((entry) => entry.full_name === repository);
  assert(selected, 'GitHub App is not installed for that repository');
  const permission = await github(
    `/repos/${repository}/collaborators/${encodeURIComponent(user.login)}/permission`,
    { fetchImpl, token: userToken },
  );
  assert(
    ['admin', 'write'].includes(permission.permission),
    'GitHub user lacks write access to the installation',
  );
  const configuration = await github(
    `/repos/${repository}/contents/lead-desk.json`,
    {
      fetchImpl,
      token: userToken,
    },
  );
  assert.equal(configuration.encoding, 'base64');
  const decoded = JSON.parse(
    new globalThis.TextDecoder('utf8', { fatal: true }).decode(
      Buffer.from(configuration.content.replaceAll(/\s/gu, ''), 'base64'),
    ),
  );
  assert.equal(decoded.repository, upstream, 'Not a Lead Desk installation');
  assert.match(decoded.revision, /^[a-f0-9]{40}$/u);
  const appJwt = await createAppJwt(appId, privateKey);
  const installation = await github(`/repos/${repository}/installation`, {
    fetchImpl,
    token: appJwt,
  });
  assert(Number.isSafeInteger(installation.id), 'Invalid App installation');
  return {
    installationId: installation.id,
    repository,
    repositoryId: selected.id,
    revision: decoded.revision,
  };
};

export const dispatchUpgrade = async (
  { actorId, actorLogin, appId, privateKey, repository, repositoryId },
  fetchImpl,
) => {
  const appJwt = await createAppJwt(appId, privateKey);
  const installation = await github(`/repos/${upstream}/installation`, {
    fetchImpl,
    token: appJwt,
  });
  const access = await github(
    `/app/installations/${installation.id}/access_tokens`,
    {
      body: {
        permissions: { actions: 'write' },
        repositories: ['cloudflare-lead-desk'],
      },
      fetchImpl,
      method: 'POST',
      token: appJwt,
    },
  );
  return github(
    `/repos/${upstream}/actions/workflows/cloudflare-upgrade.yml/dispatches`,
    {
      body: {
        inputs: {
          actor_id: String(actorId),
          actor_login: actorLogin,
          target_repository: repository,
          target_repository_id: String(repositoryId),
        },
        ref: 'main',
      },
      fetchImpl,
      method: 'POST',
      token: access.token,
    },
  );
};
