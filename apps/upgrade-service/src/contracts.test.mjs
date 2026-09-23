// Node ESM does not resolve a directory import to index.mjs.
// eslint-disable-next-line import/no-useless-path-segments
import { handle } from './index.mjs';
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
        repositories: [{ full_name: repository, id: 42 }],
        total_count: 1,
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
  assert.match(await choose.text(), /owner\/my-lead-desk/u);

  const post = (csrf, selected = repository) =>
    new globalThis.Request(`${origin}/confirm`, {
      body: new globalThis.URLSearchParams({ csrf, repository: selected }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `ld_session=${sessionCookie}`,
        origin,
      },
      method: 'POST',
    });
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
