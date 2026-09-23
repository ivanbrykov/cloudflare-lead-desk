import { exchangeUserCode, OAuthExchangeError } from './github.mjs';
// Node ESM does not resolve a directory import to index.mjs.
// eslint-disable-next-line import/no-useless-path-segments
import upgradeWorker, { handle } from './index.mjs';
import { open, seal } from './session.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

const origin = 'https://upgrade.example.test';
const repository = 'owner/my-lead-desk';
const revision = 'a'.repeat(40);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const environment = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: privateKey
    .export({ format: 'pem', type: 'pkcs1' })
    .toString(),
  GITHUB_APP_SLUG: 'lead-desk-upgrade',
  GITHUB_CLIENT_ID: 'Iv1.test',
  GITHUB_CLIENT_SECRET: 'client-secret-sentinel',
  PUBLIC_ORIGIN: origin,
  SESSION_SECRET: 'session-secret-sentinel-more-than-32-characters',
};

const response = (value) => globalThis.Response.json(value);
const cookieValue = (responseObject, name) =>
  responseObject.headers
    .get('set-cookie')
    .match(new RegExp(`${name}=([^;]+)`, 'u'))?.[1];

const fixture = ({
  collaboratorStatus,
  configurationBody,
  installedRepositories = [{ full_name: repository, id: 42 }],
  permission = 'write',
  source = 'ivanbrykov/cloudflare-lead-desk',
} = {}) => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const address = new globalThis.URL(url);
    if (address.pathname === '/login/oauth/access_token') {
      const body = new globalThis.URLSearchParams(options.body);
      assert.equal(body.get('client_secret'), environment.GITHUB_CLIENT_SECRET);
      assert(body.get('code_verifier'));
      requests.push({ method: options.method, path: address.pathname });
      return response({ access_token: 'user-token-sentinel' });
    }

    requests.push({
      body: options.body && JSON.parse(options.body),
      method: options.method,
      path: address.pathname,
    });
    if (address.pathname === '/user') {
      return response({ id: 7, login: 'owner' });
    }

    if (address.pathname === '/user/installations') {
      return response({ installations: [{ id: 99 }], total_count: 1 });
    }

    if (address.pathname === '/user/installations/99/repositories') {
      return response({
        repositories: installedRepositories,
        total_count: installedRepositories.length,
      });
    }

    if (
      address.pathname === `/repos/${repository}/collaborators/owner/permission`
    ) {
      if (collaboratorStatus) {
        return new globalThis.Response(null, { status: collaboratorStatus });
      }

      return response({ permission });
    }

    if (address.pathname === `/repos/${repository}/contents/lead-desk.json`) {
      return response({
        content: Buffer.from(
          configurationBody ??
            JSON.stringify({
              repository: source,
              revision,
            }),
        ).toString('base64'),
        encoding: 'base64',
      });
    }

    if (address.pathname.endsWith('/installation')) {
      return response({ id: 99 });
    }

    if (address.pathname === '/app/installations/99/access_tokens') {
      return response({ token: 'actions-token-sentinel' });
    }

    if (
      address.pathname.endsWith(
        '/actions/workflows/cloudflare-upgrade.yml/dispatches',
      )
    ) {
      return new globalThis.Response(null, { status: 204 });
    }

    throw new Error(`Unexpected ${options.method} ${address.pathname}`);
  };

  return { fetchImpl, requests };
};

test('sealed session rejects tampering and expiration', async () => {
  const sealed = await seal(
    { expires: Date.now() + 60_000, value: 1 },
    environment.SESSION_SECRET,
  );
  assert.equal((await open(sealed, environment.SESSION_SECRET)).value, 1);
  await assert.rejects(
    open(`${sealed}x`, environment.SESSION_SECRET),
    /Session expired or invalid/u,
  );
  await assert.rejects(
    open(
      await seal({ expires: 1 }, environment.SESSION_SECRET),
      environment.SESSION_SECRET,
    ),
    /Session expired or invalid/u,
  );
});

test('OAuth state, CSRF and App scope gate a central dispatch', async () => {
  const { fetchImpl, requests } = fixture();
  const login = await handle(
    new globalThis.Request(`${origin}/upgrade`),
    environment,
    fetchImpl,
  );
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('referrer-policy'), 'no-referrer');
  const state = new globalThis.URL(
    login.headers.get('location'),
  ).searchParams.get('state');
  const oauthCookie = cookieValue(login, 'ld_oauth');
  assert(oauthCookie);
  const invalidCallback = await handle(
    new globalThis.Request(`${origin}/callback?state=wrong&code=abc`, {
      headers: { cookie: `ld_oauth=${oauthCookie}` },
    }),
    environment,
    fetchImpl,
  );
  assert.equal(invalidCallback.status, 400);
  assert.equal(requests.length, 0);

  const callback = await handle(
    new globalThis.Request(`${origin}/callback?state=${state}&code=abc`, {
      headers: { cookie: `ld_oauth=${oauthCookie}` },
    }),
    environment,
    fetchImpl,
  );
  assert.equal(callback.status, 303);
  const sessionCookie = cookieValue(callback, 'ld_session');
  assert(sessionCookie);
  const session = await open(sessionCookie, environment.SESSION_SECRET);
  const choose = await handle(
    new globalThis.Request(`${origin}/choose`, {
      headers: { cookie: `ld_session=${sessionCookie}` },
    }),
    environment,
    fetchImpl,
  );
  assert.equal(choose.status, 200);
  assert.equal(choose.headers.get('referrer-policy'), 'same-origin');
  assert.match(await choose.text(), /owner\/my-lead-desk/u);

  const post = (csrf, selected = repository, requestOrigin = origin) =>
    new globalThis.Request(`${origin}/confirm`, {
      body: new globalThis.URLSearchParams({ csrf, repository: selected }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `ld_session=${sessionCookie}`,
        origin: requestOrigin,
      },
      method: 'POST',
    });
  const nullOrigin = await handle(
    post(session.csrf, repository, 'null'),
    environment,
    fetchImpl,
  );
  assert.equal(nullOrigin.status, 400);
  assert.equal(
    requests.some((request) => request.path.endsWith('/dispatches')),
    false,
  );
  const invalidCsrf = await handle(post('wrong'), environment, fetchImpl);
  assert.equal(invalidCsrf.status, 400);
  assert.equal(
    requests.some((request) => request.path.endsWith('/dispatches')),
    false,
  );
  const invalidRepository = await handle(
    post(session.csrf, 'attacker/other'),
    environment,
    fetchImpl,
  );
  assert.equal(invalidRepository.status, 400);

  const result = await handle(post(session.csrf), environment, fetchImpl);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await result.text(), /Upgrade requested/u);
  const dispatch = requests.find((request) =>
    request.path.endsWith('/dispatches'),
  );
  assert.deepEqual(dispatch.body, {
    inputs: {
      actor_id: '7',
      actor_login: 'owner',
      target_repository: repository,
      target_repository_id: '42',
    },
    ref: 'main',
  });
});

test('one consumer repository is preselected without dispatching from GET', async () => {
  const { fetchImpl, requests } = fixture({
    installedRepositories: [
      { full_name: 'ivanbrykov/cloudflare-lead-desk', id: 1 },
      { full_name: repository, id: 42 },
    ],
  });
  const session = await seal(
    {
      accessToken: 'user-token-sentinel',
      csrf: 'csrf-sentinel',
      expires: Date.now() + 60_000,
      userId: 7,
      userLogin: 'owner',
    },
    environment.SESSION_SECRET,
  );
  const result = await handle(
    new globalThis.Request(`${origin}/choose`, {
      headers: { cookie: `ld_session=${session}` },
    }),
    environment,
    fetchImpl,
  );
  const body = await result.text();
  assert.equal(result.status, 200);
  assert.match(body, /name="repository" value="owner\/my-lead-desk"/u);
  assert.match(body, /name="csrf" value="csrf-sentinel"/u);
  assert.match(body, /Validate and upgrade/u);
  assert.doesNotMatch(body, /<select|ivanbrykov\/cloudflare-lead-desk/u);
  assert.equal(
    requests.some((request) => request.path.endsWith('/dispatches')),
    false,
  );
});

test('zero repositories prompts installation and multiple repositories retain a chooser', async () => {
  const session = await seal(
    {
      accessToken: 'user-token-sentinel',
      csrf: 'csrf-sentinel',
      expires: Date.now() + 60_000,
      userId: 7,
      userLogin: 'owner',
    },
    environment.SESSION_SECRET,
  );
  const request = () =>
    new globalThis.Request(`${origin}/choose`, {
      headers: { cookie: `ld_session=${session}` },
    });
  const empty = fixture({ installedRepositories: [] });
  const emptyResult = await handle(request(), environment, empty.fetchImpl);
  const emptyBody = await emptyResult.text();
  assert.equal(emptyResult.status, 200);
  assert.equal(emptyResult.headers.get('referrer-policy'), 'no-referrer');
  assert.match(emptyBody, /installations\/new/u);
  assert.doesNotMatch(emptyBody, /action="\/confirm"/u);

  const multiple = fixture({
    installedRepositories: [
      { full_name: repository, id: 42 },
      { full_name: 'owner/another-lead-desk', id: 43 },
    ],
  });
  const multipleResult = await handle(
    request(),
    environment,
    multiple.fetchImpl,
  );
  const multipleBody = await multipleResult.text();
  assert.equal(multipleResult.status, 200);
  assert.equal(multipleResult.headers.get('referrer-policy'), 'same-origin');
  assert.match(multipleBody, /<select name="repository" required>/u);
  assert.match(multipleBody, /owner\/my-lead-desk/u);
  assert.match(multipleBody, /owner\/another-lead-desk/u);
  assert.equal(
    multiple.requests.some((entry) => entry.path.endsWith('/dispatches')),
    false,
  );
});

test('oversized confirmation is rejected before outbound calls', async () => {
  const { fetchImpl, requests } = fixture();
  const session = await seal(
    {
      accessToken: 'x',
      csrf: 'x',
      expires: Date.now() + 60_000,
      userId: 7,
      userLogin: 'owner',
    },
    environment.SESSION_SECRET,
  );
  const result = await handle(
    new globalThis.Request(`${origin}/confirm`, {
      body: 'x'.repeat(2_000),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `ld_session=${session}`,
        origin,
      },
      method: 'POST',
    }),
    environment,
    fetchImpl,
  );
  assert.equal(result.status, 400);
  assert.equal(requests.length, 0);
});

test('read-only requester and wrong source cannot dispatch', async () => {
  for (const variant of [
    { permission: 'read' },
    { source: 'attacker/other' },
  ]) {
    const { fetchImpl, requests } = fixture(variant);
    const session = await seal(
      {
        accessToken: 'user-token-sentinel',
        csrf: 'csrf',
        expires: Date.now() + 60_000,
        userId: 7,
        userLogin: 'owner',
      },
      environment.SESSION_SECRET,
    );
    const result = await handle(
      new globalThis.Request(`${origin}/confirm`, {
        body: new globalThis.URLSearchParams({ csrf: 'csrf', repository }),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `ld_session=${session}`,
          origin,
        },
        method: 'POST',
      }),
      environment,
      fetchImpl,
    );
    assert.equal(result.status, 400);
    assert.equal(
      requests.some((request) => request.path.endsWith('/dispatches')),
      false,
    );
  }
});

test('failure diagnostics distinguish causes without logging credentials or repository content', async () => {
  const scenarios = [
    {
      expected: { kind: 'malformed_json', status: 502 },
      fixtureOptions: { configurationBody: 'TOP_SECRET_CUSTOMER_CONTENT' },
    },
    {
      environment: { ...environment, GITHUB_APP_PRIVATE_KEY: 'TOP_SECRET_PEM' },
      expected: { kind: 'app_jwt_signing', status: 502 },
    },
    {
      expected: { kind: 'github_api', status: 502, upstreamStatus: 403 },
      fixtureOptions: { collaboratorStatus: 403 },
    },
  ];
  for (const scenario of scenarios) {
    const { fetchImpl } = fixture(scenario.fixtureOptions);
    const session = await seal(
      {
        accessToken: 'TOP_SECRET_USER_TOKEN',
        csrf: 'csrf',
        expires: Date.now() + 60_000,
        userId: 7,
        userLogin: 'owner',
      },
      environment.SESSION_SECRET,
    );
    const request = new globalThis.Request(`${origin}/confirm`, {
      body: new globalThis.URLSearchParams({ csrf: 'csrf', repository }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `ld_session=${session}`,
        origin,
      },
      method: 'POST',
    });
    const records = [];
    const original = globalThis.console.error;
    Object.defineProperty(globalThis.console, 'error', {
      configurable: true,
      value: (entry) => records.push(entry),
      writable: true,
    });
    let result;
    try {
      result = await handle(
        request,
        scenario.environment ?? environment,
        fetchImpl,
      );
    } finally {
      Object.defineProperty(globalThis.console, 'error', {
        configurable: true,
        value: original,
        writable: true,
      });
    }

    const record = JSON.parse(records.at(-1));
    assert.equal(result.status, scenario.expected.status);
    assert.equal(record.event, 'upgrade_failure');
    assert.equal(record.method, 'POST');
    assert.equal(record.route, '/confirm');
    assert.equal(record.status, scenario.expected.status);
    assert.equal(record.kind, scenario.expected.kind);
    assert.equal(record.upstreamStatus, scenario.expected.upstreamStatus);
    assert.doesNotMatch(
      `${records.join(' ')} ${await result.text()}`,
      /TOP_SECRET|ld_session|client-secret-sentinel/u,
    );
  }
});

test('OAuth exchange reports only allowlisted failure details', async () => {
  const input = {
    clientId: environment.GITHUB_CLIENT_ID,
    clientSecret: environment.GITHUB_CLIENT_SECRET,
    code: 'TOP_SECRET_AUTH_CODE',
    codeVerifier: 'TOP_SECRET_VERIFIER',
    redirectUri: `${origin}/callback`,
  };
  await assert.rejects(
    exchangeUserCode(input, async () =>
      response({
        error: 'incorrect_client_credentials',
        error_description: 'TOP_SECRET_GITHUB_DESCRIPTION',
      }),
    ),
    (error) =>
      error instanceof OAuthExchangeError &&
      error.kind === 'oauth_response_incorrect_client_credentials' &&
      !error.message.includes('TOP_SECRET'),
  );
  await assert.rejects(
    exchangeUserCode(input, async () => {
      throw new TypeError('TOP_SECRET_TRANSPORT_DETAIL');
    }),
    (error) =>
      error instanceof OAuthExchangeError &&
      error.kind === 'oauth_transport_error' &&
      !error.message.includes('TOP_SECRET'),
  );
});

test('callback logs a sanitized GitHub OAuth response category', async () => {
  const start = await handle(
    new globalThis.Request(`${origin}/upgrade`),
    environment,
  );
  const state = new globalThis.URL(
    start.headers.get('location'),
  ).searchParams.get('state');
  const oauthCookie = cookieValue(start, 'ld_oauth');
  const records = [];
  const original = globalThis.console.error;
  Object.defineProperty(globalThis.console, 'error', {
    configurable: true,
    value: (entry) => records.push(entry),
    writable: true,
  });
  let result;
  try {
    result = await handle(
      new globalThis.Request(
        `${origin}/callback?state=${state}&code=TOP_SECRET_AUTH_CODE`,
        {
          headers: { cookie: `ld_oauth=${oauthCookie}` },
        },
      ),
      environment,
      async () =>
        response({
          error: 'incorrect_client_credentials',
          error_description: 'TOP_SECRET_GITHUB_DESCRIPTION',
        }),
    );
  } finally {
    Object.defineProperty(globalThis.console, 'error', {
      configurable: true,
      value: original,
      writable: true,
    });
  }

  const diagnostic = JSON.parse(records.at(-1));
  assert.equal(result.status, 502);
  assert.equal(diagnostic.kind, 'oauth_response_incorrect_client_credentials');
  assert.equal(diagnostic.route, '/callback');
  assert.doesNotMatch(
    `${records.join(' ')} ${await result.text()}`,
    /TOP_SECRET/u,
  );
});

test('Cloudflare entry point does not use ExecutionContext as outbound fetch', async () => {
  const calls = [];
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (url) => {
      const path = new globalThis.URL(url).pathname;
      calls.push(path);
      if (path === '/login/oauth/access_token') {
        return response({ access_token: 'user-token-sentinel' });
      }

      if (path === '/user') {
        return response({ id: 7, login: 'owner' });
      }

      throw new Error(`Unexpected outbound path ${path}`);
    },
    writable: true,
  });
  try {
    const executionContext = { waitUntil() {} };
    const start = await upgradeWorker.fetch(
      new globalThis.Request(`${origin}/upgrade`),
      environment,
      executionContext,
    );
    const state = new globalThis.URL(
      start.headers.get('location'),
    ).searchParams.get('state');
    const oauthCookie = cookieValue(start, 'ld_oauth');
    const result = await upgradeWorker.fetch(
      new globalThis.Request(
        `${origin}/callback?state=${state}&code=diagnostic-only`,
        {
          headers: { cookie: `ld_oauth=${oauthCookie}` },
        },
      ),
      environment,
      executionContext,
    );
    assert.equal(result.status, 303);
    assert.equal(
      new globalThis.URL(result.headers.get('location')).pathname,
      '/choose',
    );
    assert.deepEqual(calls, ['/login/oauth/access_token', '/user']);
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: original,
      writable: true,
    });
  }
});
