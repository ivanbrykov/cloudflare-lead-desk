import { assertRuntimeConfig } from '../../templates/cloudflare/scripts/installed.mjs';
import {
  assertMigrationHistory,
  checksum,
  download,
  resolveRelease,
  validateManifest,
} from '../../templates/cloudflare/scripts/release.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const commit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const digest = 'c'.repeat(64);
const migrationDigest = 'd'.repeat(64);
const tag = `build-${commit}`;
const repository = 'ivanbrykov/cloudflare-lead-desk';
const base = `https://github.com/${repository}/releases/download/${tag}`;

const manifest = (overrides = {}) => ({
  asset: 'lead-desk.tgz',
  commit,
  compatibilityDate: '2026-08-23',
  compatibilityFlags: ['nodejs_compat'],
  migrations: [
    {
      name: '0001_initial.sql',
      sha256: migrationDigest,
    },
  ],
  packageName: '@ivanbrykov/lead-desk',
  schemaVersion: 1,
  sha256: digest,
  version: '1.2.3',
  ...overrides,
});

const release = (overrides = {}) => ({
  assets: [
    { name: 'lead-desk.tgz', state: 'uploaded' },
    { name: 'lead-desk.json', state: 'uploaded' },
  ],
  draft: false,
  prerelease: false,
  tag_name: tag,
  ...overrides,
});

const jsonResponse = (value, init = {}) =>
  new globalThis.Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });

test('resolveRelease resolves latest once and pins downloads to that exact tag', async () => {
  const requests = [];
  let latestCalls = 0;
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('/releases/latest')) {
      latestCalls += 1;
      return jsonResponse(release());
    }

    assert.equal(url, `${base}/lead-desk.json`);
    return jsonResponse(manifest());
  };

  const selected = await resolveRelease({
    fetchImpl,
    release: 'latest',
    repository,
  });

  assert.equal(latestCalls, 1);
  assert.deepEqual(requests, [
    `https://api.github.com/repos/${repository}/releases/latest`,
    `${base}/lead-desk.json`,
  ]);
  assert.deepEqual(selected, {
    manifest: manifest(),
    tag,
    url: `${base}/lead-desk.tgz`,
  });
});

test('resolveRelease rejects unpublished releases and missing required assets', async (context) => {
  for (const [name, fixture, expected] of [
    ['draft', release({ draft: true }), /not published/u],
    ['prerelease', release({ prerelease: true }), /not published/u],
    [
      'missing manifest',
      release({ assets: [{ name: 'lead-desk.tgz', state: 'uploaded' }] }),
      /missing lead-desk\.json/u,
    ],
  ]) {
    await context.test(name, async () => {
      await assert.rejects(
        resolveRelease({
          fetchImpl: async () => jsonResponse(fixture),
          repository,
        }),
        expected,
      );
    });
  }
});

test('resolveRelease rejects a pinned tag response for a different build', async () => {
  await assert.rejects(
    resolveRelease({
      fetchImpl: async (url) => {
        assert.equal(
          url,
          `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
        );
        return jsonResponse(release({ tag_name: `build-${nextCommit}` }));
      },
      release: tag,
      repository,
    }),
    /wrong pinned release/iu,
  );
});

test('validateManifest rejects malformed manifests and unsafe or duplicated migration names', () => {
  assert.throws(
    () => validateManifest(manifest({ sha256: 'not-a-sha256' })),
    /missing archive SHA-256/iu,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({
          migrations: [
            { name: '../0001_initial.sql', sha256: migrationDigest },
          ],
        }),
      ),
    /unsafe migration filename/iu,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({
          migrations: [
            { name: '0001_initial.sql', sha256: migrationDigest },
            { name: '0001_initial.sql', sha256: digest },
          ],
        }),
      ),
    /duplicate migration filename/iu,
  );
});

test('migration history permits appending but rejects deleted and rewritten migrations', () => {
  const previous = manifest();
  const appended = manifest({
    migrations: [
      ...previous.migrations,
      { name: '0002_add_pipeline.sql', sha256: digest },
    ],
  });

  assert.doesNotThrow(() => assertMigrationHistory(previous, appended));
  assert.throws(
    () => assertMigrationHistory(previous, manifest({ migrations: [] })),
    /removed or rewritten/u,
  );
  assert.throws(
    () =>
      assertMigrationHistory(
        previous,
        manifest({
          migrations: [{ name: '0001_initial.sql', sha256: digest }],
        }),
      ),
    /removed or rewritten/u,
  );
});

test('download enforces its byte limit even without a content-length header', async () => {
  const bytes = Buffer.from('12345');
  const received = await download('https://example.test/ok', {
    fetchImpl: async () => new globalThis.Response(bytes),
    limit: bytes.length,
  });
  assert.equal(checksum(received), checksum(bytes));

  await assert.rejects(
    download('https://example.test/header-too-large', {
      fetchImpl: async () =>
        new globalThis.Response('small', {
          headers: { 'content-length': '6' },
        }),
      limit: 5,
    }),
    /too large/u,
  );
  await assert.rejects(
    download('https://example.test/stream-too-large', {
      fetchImpl: async () => new globalThis.Response('123456'),
      limit: 5,
    }),
    /exceeded the size limit/u,
  );
});

test('download reports HTTP errors before consuming a response body', async () => {
  await assert.rejects(
    download('https://example.test/missing', {
      fetchImpl: async () =>
        new globalThis.Response('not found', { status: 404 }),
    }),
    /HTTP 404/u,
  );
});

test('assertRuntimeConfig rejects missing release compatibility requirements', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'lead-desk-release-test-'));
  context.after(async () => rm(root, { force: true, recursive: true }));
  const config = {
    assets: { binding: 'ASSETS', directory: '.lead-desk/current/assets' },
    compatibility_date: '2026-08-22',
    compatibility_flags: [],
    d1_databases: [
      { binding: 'DB', migrations_dir: '.lead-desk/current/migrations' },
    ],
  };
  await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify(config));

  await assert.rejects(
    assertRuntimeConfig(root, manifest()),
    /compatibility_date/u,
  );

  await writeFile(
    join(root, 'wrangler.jsonc'),
    JSON.stringify({ ...config, compatibility_date: '2026-08-23' }),
  );
  await assert.rejects(
    assertRuntimeConfig(root, manifest()),
    /compatibility_flags/u,
  );
});

test('release version validation accepts build metadata and rejects invalid leading zeroes', () => {
  assert.doesNotThrow(() =>
    validateManifest(manifest({ version: '1.2.3+build.1' })),
  );
  assert.throws(
    () => validateManifest(manifest({ version: '01.2.3' })),
    /Invalid package version/u,
  );
});

test('new migrations must follow the previously published ordering', () => {
  const previous = manifest();
  assert.throws(
    () =>
      assertMigrationHistory(
        previous,
        manifest({
          migrations: [
            { name: '0000_backfilled.sql', sha256: digest },
            ...previous.migrations,
          ],
        }),
      ),
    /must sort after/u,
  );
});
