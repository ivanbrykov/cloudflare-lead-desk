import {
  checksum,
  validateManifest,
} from '../../templates/cloudflare/scripts/release.mjs';
import { publishRelease } from './publish.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const commit = 'a'.repeat(40);
const priorCommit = 'b'.repeat(40);
const migrationDigest = 'c'.repeat(64);
const priorMigrationDigest = 'd'.repeat(64);
const repository = 'ivanbrykov/cloudflare-lead-desk';
const tag = `build-${commit}`;
const releaseId = 123;

const manifest = (overrides = {}) => ({
  asset: 'lead-desk.tgz',
  commit,
  compatibilityDate: '2026-08-23',
  compatibilityFlags: ['nodejs_compat'],
  migrations: [{ name: '0001_initial.sql', sha256: migrationDigest }],
  packageName: '@ivanbrykov/lead-desk',
  schemaVersion: 1,
  sha256: '0'.repeat(64),
  version: '1.2.3',
  ...overrides,
});

const githubRelease = (overrides = {}) => ({
  assets: [],
  draft: true,
  id: releaseId,
  prerelease: false,
  tag_name: tag,
  ...overrides,
});

const jsonResponse = (value, init = {}) =>
  new globalThis.Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const notFound = () => new globalThis.Response(null, { status: 404 });

const artifact = async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-desk-publish-test-'));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const archive = Buffer.from('lead-desk test archive');
  const metadata = manifest({ sha256: checksum(archive) });
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  validateManifest(metadata);
  await writeFile(join(directory, 'lead-desk.tgz'), archive);
  await writeFile(join(directory, 'lead-desk.json'), metadataBytes);
  return { archive, directory, metadata, metadataBytes };
};

const apiUrl = (path) => `https://api.github.com/repos/${repository}/${path}`;
const uploadUrl = (name) =>
  `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${name}`;

const header = (headers, name) => {
  if (headers instanceof globalThis.Headers) {
    return headers.get(name);
  }

  return headers?.[name] ?? headers?.[name.toLowerCase()];
};

const fetchScript = (steps) => {
  const remaining = [...steps];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const step = remaining.shift();
    assert(step, `Unexpected GitHub request: ${url}`);
    calls.push({ options, url: String(url) });
    assert.equal(String(url), step.url);
    assert.equal(options.method, step.method);
    if (step.publicDownload) {
      assert.equal(header(options.headers, 'Authorization'), undefined);
    } else if (step.legacyApi) {
      assert.equal(
        header(options.headers, 'Authorization'),
        'Bearer test-token',
      );
    } else {
      assert.equal(
        header(options.headers, 'Accept'),
        'application/vnd.github+json',
      );
      assert.equal(
        header(options.headers, 'Authorization'),
        'Bearer test-token',
      );
      assert.equal(header(options.headers, 'Cache-Control'), 'no-cache');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
    }

    await step.assert?.(options);
    return typeof step.response === 'function'
      ? step.response()
      : step.response;
  };

  return {
    assertDone: () => assert.deepEqual(remaining, []),
    calls,
    fetchImpl,
  };
};

const get = (path, response, options = {}) => ({
  method: 'GET',
  response,
  url: apiUrl(path),
  ...options,
});

const releaseBody = (metadata) =>
  `Lead Desk ${metadata.version}\n\nSource commit: ${commit}\n\nTested main build for installations following latest. Apply pending D1 migrations before deploying.\n\nArchive SHA-256: ${metadata.sha256}\n`;

const uploadedAsset = (name, bytes, id) => ({
  digest: `sha256:${checksum(bytes)}`,
  id,
  name,
  size: bytes.length,
  state: 'uploaded',
});

test('publishRelease uses the create response ID when listings remain stale, uploads distinct assets, then publishes', async (context) => {
  const { archive, directory, metadata, metadataBytes } =
    await artifact(context);
  const archiveAsset = uploadedAsset('lead-desk.tgz', archive, 456);
  const metadataAsset = uploadedAsset('lead-desk.json', metadataBytes, 789);
  const script = fetchScript([
    get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
    get(`releases/tags/${tag}`, notFound()),
    get('releases?per_page=100&page=1', jsonResponse([])),
    get('releases/latest', notFound()),
    {
      assert: (options) => {
        assert.equal(
          header(options.headers, 'Content-Type'),
          'application/json',
        );
        assert.deepEqual(JSON.parse(options.body), {
          body: releaseBody(metadata),
          draft: true,
          name: `Lead Desk ${metadata.version}`,
          prerelease: false,
          tag_name: tag,
          target_commitish: commit,
        });
      },
      method: 'POST',
      response: jsonResponse(githubRelease()),
      url: apiUrl('releases'),
    },
    get(`releases/${releaseId}`, jsonResponse(githubRelease())),
    {
      assert: (options) => {
        assert.equal(
          header(options.headers, 'Content-Type'),
          'application/octet-stream',
        );
        assert(Buffer.isBuffer(options.body));
        assert.deepEqual(options.body, archive);
      },
      method: 'POST',
      response: jsonResponse(archiveAsset),
      url: uploadUrl('lead-desk.tgz'),
    },
    get(
      `releases/${releaseId}`,
      jsonResponse(githubRelease({ assets: [archiveAsset] })),
    ),
    {
      assert: (options) => {
        assert(Buffer.isBuffer(options.body));
        assert.deepEqual(options.body, metadataBytes);
      },
      method: 'POST',
      response: jsonResponse(metadataAsset),
      url: uploadUrl('lead-desk.json'),
    },
    get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
    get(
      `releases/${releaseId}`,
      jsonResponse(githubRelease({ assets: [archiveAsset, metadataAsset] })),
    ),
    {
      assert: (options) => {
        assert.equal(
          header(options.headers, 'Content-Type'),
          'application/json',
        );
        assert.deepEqual(JSON.parse(options.body), {
          draft: false,
          make_latest: 'true',
        });
      },
      method: 'PATCH',
      response: jsonResponse(
        githubRelease({ assets: [archiveAsset, metadataAsset], draft: false }),
      ),
      url: apiUrl(`releases/${releaseId}`),
    },
  ]);
  await publishRelease({
    commit,
    directory,
    fetchImpl: script.fetchImpl,
    repository,
    token: 'test-token',
  });
  script.assertDone();
  assert.equal(
    script.calls.filter(({ url }) => url.includes('releases?per_page=100'))
      .length,
    1,
    'the new release must not be rediscovered through a stale listing',
  );
});

test('publishRelease makes no GitHub mutations for superseded main or an existing published tag', async (context) => {
  await context.test('superseded main', async (subcontext) => {
    const { directory } = await artifact(subcontext);
    const script = fetchScript([
      get('git/ref/heads/main', jsonResponse({ object: { sha: priorCommit } })),
    ]);
    await publishRelease({
      commit,
      directory,
      fetchImpl: script.fetchImpl,
      repository,
      token: 'test-token',
    });
    script.assertDone();
    assert.equal(
      script.calls.some(({ options }) => options.method !== 'GET'),
      false,
    );
  });
  await context.test('published tag', async (subcontext) => {
    const { directory } = await artifact(subcontext);
    const script = fetchScript([
      get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
      get(
        `releases/tags/${tag}`,
        jsonResponse(githubRelease({ draft: false })),
      ),
    ]);
    await publishRelease({
      commit,
      directory,
      fetchImpl: script.fetchImpl,
      repository,
      token: 'test-token',
    });
    script.assertDone();
    assert.equal(
      script.calls.some(({ options }) => options.method !== 'GET'),
      false,
    );
  });
});

test('publishRelease rejects a rewritten migration before creating a release', async (context) => {
  const { directory } = await artifact(context);
  const previousTag = `build-${priorCommit}`;
  const previous = manifest({
    commit: priorCommit,
    migrations: [{ name: '0001_initial.sql', sha256: priorMigrationDigest }],
  });
  const published = githubRelease({
    assets: [
      { name: 'lead-desk.tgz', state: 'uploaded' },
      { name: 'lead-desk.json', state: 'uploaded' },
    ],
    draft: false,
    tag_name: previousTag,
  });
  const script = fetchScript([
    get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
    get(`releases/tags/${tag}`, notFound()),
    get('releases?per_page=100&page=1', jsonResponse([])),
    get('releases/latest', jsonResponse(published)),
    {
      legacyApi: true,
      method: undefined,
      response: jsonResponse(published),
      url: apiUrl('releases/latest'),
    },
    {
      method: undefined,
      publicDownload: true,
      response: jsonResponse(previous),
      url: `https://github.com/${repository}/releases/download/${previousTag}/lead-desk.json`,
    },
  ]);
  await assert.rejects(
    publishRelease({
      commit,
      directory,
      fetchImpl: script.fetchImpl,
      repository,
      token: 'test-token',
    }),
    /removed or rewritten/iu,
  );
  script.assertDone();
  assert.equal(
    script.calls.some(({ options }) => options.method === 'POST'),
    false,
  );
});

test('publishRelease rejects a mismatched pre-existing draft asset without mutation', async (context) => {
  const { directory } = await artifact(context);
  const draft = githubRelease({
    assets: [
      {
        digest: `sha256:${'f'.repeat(64)}`,
        name: 'lead-desk.tgz',
        state: 'uploaded',
      },
    ],
  });
  const script = fetchScript([
    get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
    get(`releases/tags/${tag}`, notFound()),
    get('releases?per_page=100&page=1', jsonResponse([draft])),
    get('releases/latest', notFound()),
    get(`releases/${releaseId}`, jsonResponse(draft)),
  ]);
  await assert.rejects(
    publishRelease({
      commit,
      directory,
      fetchImpl: script.fetchImpl,
      repository,
      token: 'test-token',
    }),
    /existing draft asset differs/iu,
  );
  script.assertDone();
  assert.equal(
    script.calls.some(({ options }) => options.method !== 'GET'),
    false,
  );
});

test('publishRelease stops when a draft is manually published before upload', async (context) => {
  const { directory, metadata } = await artifact(context);
  const script = fetchScript([
    get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
    get(`releases/tags/${tag}`, notFound()),
    get('releases?per_page=100&page=1', jsonResponse([])),
    get('releases/latest', notFound()),
    {
      assert: (options) =>
        assert.equal(JSON.parse(options.body).body, releaseBody(metadata)),
      method: 'POST',
      response: jsonResponse(githubRelease()),
      url: apiUrl('releases'),
    },
    get(`releases/${releaseId}`, jsonResponse(githubRelease({ draft: false }))),
  ]);
  await assert.rejects(
    publishRelease({
      commit,
      directory,
      fetchImpl: script.fetchImpl,
      repository,
      token: 'test-token',
    }),
    /changed state during publishing/iu,
  );
  script.assertDone();
  assert.equal(
    script.calls.filter(({ options }) => options.method === 'POST').length,
    1,
  );
});

test('publishRelease resumes a draft on a later listing page without recreating or overwriting assets', async (context) => {
  const { archive, directory, metadataBytes } = await artifact(context);
  const archiveAsset = uploadedAsset('lead-desk.tgz', archive, 456);
  const metadataAsset = uploadedAsset('lead-desk.json', metadataBytes, 789);
  const draft = githubRelease({ assets: [archiveAsset] });
  const script = fetchScript([
    get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
    get(`releases/tags/${tag}`, notFound()),
    get(
      'releases?per_page=100&page=1',
      jsonResponse(
        Array.from({ length: 100 }, (_, index) =>
          githubRelease({
            draft: false,
            id: index + 1_000,
            tag_name: `other-${index}`,
          }),
        ),
      ),
    ),
    get('releases?per_page=100&page=2', jsonResponse([draft])),
    get('releases/latest', notFound()),
    get(`releases/${releaseId}`, jsonResponse(draft)),
    get(`releases/${releaseId}`, jsonResponse(draft)),
    {
      assert: (options) => assert.deepEqual(options.body, metadataBytes),
      method: 'POST',
      response: jsonResponse(metadataAsset),
      url: uploadUrl('lead-desk.json'),
    },
    get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
    get(
      `releases/${releaseId}`,
      jsonResponse(githubRelease({ assets: [archiveAsset, metadataAsset] })),
    ),
    {
      method: 'PATCH',
      response: jsonResponse(
        githubRelease({ assets: [archiveAsset, metadataAsset], draft: false }),
      ),
      url: apiUrl(`releases/${releaseId}`),
    },
  ]);
  await publishRelease({
    commit,
    directory,
    fetchImpl: script.fetchImpl,
    repository,
    token: 'test-token',
  });
  script.assertDone();
  assert.equal(
    script.calls.some(({ url }) => url === uploadUrl('lead-desk.tgz')),
    false,
  );
  assert.equal(
    script.calls.filter(({ url }) => url.includes('releases?per_page=100'))
      .length,
    2,
  );
});

test('publishRelease refuses an ID lookup that returns a different release tag', async (context) => {
  const { directory } = await artifact(context);
  const script = fetchScript([
    get('git/ref/heads/main', jsonResponse({ object: { sha: commit } })),
    get(`releases/tags/${tag}`, notFound()),
    get('releases?per_page=100&page=1', jsonResponse([githubRelease()])),
    get('releases/latest', notFound()),
    get(
      `releases/${releaseId}`,
      jsonResponse(githubRelease({ tag_name: `build-${priorCommit}` })),
    ),
  ]);
  await assert.rejects(
    publishRelease({
      commit,
      directory,
      fetchImpl: script.fetchImpl,
      repository,
      token: 'test-token',
    }),
    /changed state during publishing/iu,
  );
  script.assertDone();
});
