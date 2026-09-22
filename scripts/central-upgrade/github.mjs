import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createPrivateKey, sign } from 'node:crypto';

export const upstream = 'ivanbrykov/cloudflare-lead-desk';
export const repositoryPattern = /^[\w.-]+\/[\w.-]+$/u;
export const shaPattern = /^[a-f0-9]{40}$/u;

const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export const appJwt = ({ appId, privateKey }) => {
  assert(/^\d+$/u.test(String(appId)), 'Invalid GitHub App ID');
  const now = Math.floor(Date.now() / 1_000);
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ exp: now + 540, iat: now - 30, iss: String(appId) })}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(payload),
    createPrivateKey(privateKey.replaceAll('\\n', '\n')),
  ).toString('base64url');
  return `${payload}.${signature}`;
};

export const api = async (
  path,
  { body, fetchImpl = globalThis.fetch, method = 'GET', token },
) => {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'lead-desk-central-upgrade',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    method,
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  assert(response.ok, `GitHub ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
};

export const installationToken = async ({
  appId,
  fetchImpl,
  permission,
  privateKey,
  repository,
  repositoryId,
}) => {
  assert(repositoryPattern.test(repository), 'Invalid repository');
  assert(Number.isSafeInteger(repositoryId) && repositoryId > 0);
  assert(['read', 'write'].includes(permission));
  const jwt = appJwt({ appId, privateKey });
  const installation = await api(`/repos/${repository}/installation`, {
    fetchImpl,
    token: jwt,
  });
  const access = await api(
    `/app/installations/${installation.id}/access_tokens`,
    {
      body: {
        permissions: { contents: permission },
        repository_ids: [repositoryId],
      },
      fetchImpl,
      method: 'POST',
      token: jwt,
    },
  );
  assert(access?.token, 'GitHub App returned no installation token');
  return access.token;
};

export const readConfiguration = async (
  repository,
  token,
  revision,
  fetchImpl,
) => {
  const suffix = revision ? `?ref=${encodeURIComponent(revision)}` : '';
  const file = await api(
    `/repos/${repository}/contents/lead-desk.json${suffix}`,
    { fetchImpl, token },
  );
  assert.equal(file.encoding, 'base64', 'Unexpected Lead Desk config encoding');
  const configuration = JSON.parse(
    Buffer.from(file.content, 'base64').toString('utf8'),
  );
  assert.deepEqual(
    Object.keys(configuration).toSorted(),
    ['repository', 'revision'],
    'Unexpected Lead Desk config fields',
  );
  assert.equal(
    configuration.repository,
    upstream,
    'Not a Lead Desk installation',
  );
  assert(shaPattern.test(configuration.revision), 'Invalid source pin');
  return configuration;
};

export const assertActorCanUpgrade = async ({
  actorId,
  actorLogin,
  fetchImpl,
  repository,
  token,
}) => {
  const user = await api(`/users/${encodeURIComponent(actorLogin)}`, {
    fetchImpl,
    token,
  });
  assert.equal(user.id, actorId, 'Upgrade actor ID changed');
  const result = await api(
    `/repos/${repository}/collaborators/${encodeURIComponent(actorLogin)}/permission`,
    { fetchImpl, token },
  );
  assert(
    ['admin', 'write'].includes(result.permission),
    'Upgrade actor lacks write access',
  );
};
