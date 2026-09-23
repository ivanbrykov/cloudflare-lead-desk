import {
  dispatchUpgrade,
  exchangeUserCode,
  getUser,
  listUserRepositories,
  OAuthExchangeError,
  verifyUpgradeTarget,
} from './github.mjs';
import { cookie, open, random, readCookie, seal } from './session.mjs';
import assert from 'node:assert/strict';

const upstream = 'ivanbrykov/cloudflare-lead-desk';
const knownRoutes = new Set([
  '/',
  '/callback',
  '/choose',
  '/confirm',
  '/upgrade',
]);

const failureCategory = (error) => {
  if (error instanceof OAuthExchangeError) {
    return {
      kind: error.kind,
      ...(error.upstreamStatus && { upstreamStatus: error.upstreamStatus }),
    };
  }

  const message = typeof error?.message === 'string' ? error.message : '';
  if (message === 'App JWT signing failed') {
    return { kind: 'app_jwt_signing' };
  }

  const upstreamStatus = /HTTP (\d{3})$/u.exec(message)?.[1];
  if (upstreamStatus && message.startsWith('GitHub API ')) {
    return { kind: 'github_api', upstreamStatus: Number(upstreamStatus) };
  }

  if (upstreamStatus && message.startsWith('GitHub authorization failed:')) {
    return { kind: 'github_oauth', upstreamStatus: Number(upstreamStatus) };
  }

  if (error?.name === 'TimeoutError') {
    return { kind: 'timeout' };
  }

  if (error?.name === 'SyntaxError') {
    return { kind: 'malformed_json' };
  }

  if (error?.name === 'AssertionError') {
    return { kind: 'validation' };
  }

  return { kind: 'unexpected' };
};

const readSmallForm = async (request) => {
  const length = Number(request.headers.get('content-length') ?? 0);
  assert(Number.isSafeInteger(length) && length <= 1_024, 'Form too large');
  const reader = request.body?.getReader();
  assert(reader, 'Missing form body');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      total += value.byteLength;
      assert(total <= 1_024, 'Form too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new globalThis.TextDecoder('utf8', { fatal: true }).decode(bytes);
};

const escapeHtml = (value) =>
  String(value).replaceAll(
    /[&<>"']/gu,
    (character) =>
      ({ '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' })[
        character
      ],
  );

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const html = (title, body, status = 200, additional = {}) =>
  new globalThis.Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{max-width:42rem;margin:3rem auto;padding:0 1rem;font:16px/1.5 system-ui}button{padding:.6rem 1rem}li{margin:.7rem 0}</style><h1>${escapeHtml(title)}</h1>${body}</html>`,
    {
      headers: {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        ...additional,
      },
      status,
    },
  );

const redirect = (location, cookies = []) => {
  const response = new globalThis.Response(null, {
    headers: { ...headers, Location: location },
    status: 303,
  });
  for (const value of cookies) {
    response.headers.append('Set-Cookie', value);
  }

  return response;
};

const configuration = (environment) => {
  const origin = new globalThis.URL(environment.PUBLIC_ORIGIN);
  assert.equal(origin.protocol, 'https:', 'PUBLIC_ORIGIN must use HTTPS');
  assert.equal(
    origin.href,
    `${origin.origin}/`,
    'PUBLIC_ORIGIN must be an HTTPS origin without path or query',
  );
  for (const key of [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_APP_SLUG',
    'SESSION_SECRET',
  ]) {
    assert(environment[key], `Missing ${key}`);
  }

  return origin.origin;
};

const login = async (environment, origin) => {
  const state = random();
  const verifier = random();
  const hash = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      new globalThis.TextEncoder().encode(verifier),
    ),
  );
  const challenge = globalThis
    .btoa(String.fromCodePoint(...hash))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const authorization = new globalThis.URL(
    'https://github.com/login/oauth/authorize',
  );
  authorization.searchParams.set('client_id', environment.GITHUB_CLIENT_ID);
  authorization.searchParams.set('redirect_uri', `${origin}/callback`);
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('code_challenge', challenge);
  authorization.searchParams.set('code_challenge_method', 'S256');
  return redirect(authorization.href, [
    cookie(
      'ld_oauth',
      await seal(
        { expires: Date.now() + 600_000, state, verifier },
        environment.SESSION_SECRET,
      ),
    ),
  ]);
};

const callback = async (request, environment, origin, fetchImpl) => {
  const url = new globalThis.URL(request.url);
  const state = await open(
    readCookie(request, 'ld_oauth') ?? '',
    environment.SESSION_SECRET,
  );
  assert.equal(
    url.searchParams.get('state'),
    state.state,
    'OAuth state mismatch',
  );
  const code = url.searchParams.get('code');
  assert(code && code.length < 512, 'Missing GitHub authorization code');
  const accessToken = await exchangeUserCode(
    {
      clientId: environment.GITHUB_CLIENT_ID,
      clientSecret: environment.GITHUB_CLIENT_SECRET,
      code,
      codeVerifier: state.verifier,
      redirectUri: `${origin}/callback`,
    },
    fetchImpl,
  );
  const user = await getUser(accessToken, fetchImpl);
  assert(Number.isSafeInteger(user.id) && user.login, 'Invalid GitHub user');
  return redirect(`${origin}/choose`, [
    cookie('ld_oauth', '', 0),
    cookie(
      'ld_session',
      await seal(
        {
          accessToken,
          csrf: random(),
          expires: Date.now() + 600_000,
          userId: user.id,
          userLogin: user.login,
        },
        environment.SESSION_SECRET,
      ),
    ),
  ]);
};

const choose = async (request, environment, fetchImpl) => {
  const session = await open(
    readCookie(request, 'ld_session') ?? '',
    environment.SESSION_SECRET,
  );
  const repositories = await listUserRepositories(
    session.accessToken,
    fetchImpl,
  );
  if (repositories.length === 0) {
    return html(
      'Authorize Lead Desk Upgrade',
      `<p>Install the GitHub App on the Lead Desk repository you want to upgrade, then return here.</p><p><a href="https://github.com/apps/${encodeURIComponent(environment.GITHUB_APP_SLUG)}/installations/new">Choose a repository on GitHub</a></p>`,
    );
  }

  const selection =
    repositories.length === 1
      ? `<p>Confirm this is the Lead Desk installation you want to upgrade: <strong>${escapeHtml(repositories[0].full_name)}</strong>.</p><input type="hidden" name="repository" value="${escapeHtml(repositories[0].full_name)}">`
      : `<p>Select the installation to validate against the latest upstream main commit.</p><label>Installation <select name="repository" required>${repositories
          .map(
            (repository) =>
              `<option value="${escapeHtml(repository.full_name)}">${escapeHtml(repository.full_name)}</option>`,
          )
          .join('')}</select></label>`;
  return html(
    'Upgrade Lead Desk',
    `<form action="/confirm" method="post"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">${selection}<p><button type="submit">Validate and upgrade</button></p></form>`,
  );
};

const confirm = async (request, environment, origin, fetchImpl) => {
  assert.equal(request.headers.get('origin'), origin, 'Invalid request origin');
  assert.match(
    request.headers.get('content-type') ?? '',
    /^application\/x-www-form-urlencoded(?:;|$)/iu,
    'Invalid form content type',
  );
  const session = await open(
    readCookie(request, 'ld_session') ?? '',
    environment.SESSION_SECRET,
  );
  const body = await readSmallForm(request);
  const form = new globalThis.URLSearchParams(body);
  assert.equal(form.get('csrf'), session.csrf, 'Invalid confirmation token');
  const user = await getUser(session.accessToken, fetchImpl);
  assert.equal(user.id, session.userId, 'GitHub user changed');
  assert.equal(user.login, session.userLogin, 'GitHub user changed');
  const target = await verifyUpgradeTarget(
    {
      appId: environment.GITHUB_APP_ID,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
      repository: form.get('repository'),
      user,
      userToken: session.accessToken,
    },
    fetchImpl,
  );
  const run = await dispatchUpgrade(
    {
      actorId: user.id,
      actorLogin: user.login,
      appId: environment.GITHUB_APP_ID,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
      repository: target.repository,
      repositoryId: target.repositoryId,
    },
    fetchImpl,
  );
  const location =
    run?.html_url ??
    `https://github.com/${upstream}/actions/workflows/cloudflare-upgrade.yml`;
  const response = html(
    'Upgrade requested',
    `<p>Requested validation for <strong>${escapeHtml(target.repository)}</strong> from source <code>${escapeHtml(target.revision)}</code>.</p><p><a href="${escapeHtml(location)}">View upgrade workflow</a></p>`,
  );
  response.headers.append('Set-Cookie', cookie('ld_session', '', 0));
  return response;
};

export const handle = async (
  request,
  environment,
  fetchImpl = globalThis.fetch,
) => {
  try {
    const origin = configuration(environment);
    const url = new globalThis.URL(request.url);
    if (url.origin !== origin) {
      return html('Invalid origin', '', 400);
    }

    if (request.method === 'GET' && ['/', '/upgrade'].includes(url.pathname)) {
      return await login(environment, origin);
    }

    if (request.method === 'GET' && url.pathname === '/callback') {
      return await callback(request, environment, origin, fetchImpl);
    }

    if (request.method === 'GET' && url.pathname === '/choose') {
      return await choose(request, environment, fetchImpl);
    }

    if (request.method === 'POST' && url.pathname === '/confirm') {
      return await confirm(request, environment, origin, fetchImpl);
    }

    return html('Not found', '', 404);
  } catch (error) {
    const status =
      /Invalid|Malformed|Missing|expired|lacks|not installed|Not a Lead Desk|mismatch|too large/u.test(
        error.message,
      )
        ? 400
        : 502;
    const path = new globalThis.URL(request.url).pathname;
    globalThis.console.error(
      JSON.stringify({
        event: 'upgrade_failure',
        method: request.method,
        route: knownRoutes.has(path) ? path : 'other',
        status,
        ...failureCategory(error),
      }),
    );
    return html(
      'Upgrade could not start',
      '<p>Please retry or check that the GitHub App is installed for your repository.</p>',
      status,
    );
  }
};

// Cloudflare supplies ExecutionContext as the third handler argument. Keep the
// injectable HTTP fetch parameter on handle() separate from that runtime API.
export default {
  fetch: (request, environment) => handle(request, environment),
};
