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
  validateManifest(metadata);
  await writeFile(join(directory, 'lead-desk.tgz'), archive);
  await writeFile(join(directory, 'lead-desk.json'), JSON.stringify(metadata));
  return { archive, directory, metadata };
};

const releaseUrl = (path) =>
  `https://api.github.com/repos/${repository}/${path}`;

test('publishRelease creates a draft, uploads both assets without clobber, then publishes latest', async (context) => {
  const { directory, metadata } = await artifact(context);
  const ghCalls = [];
  const requests = [];
  let created = false;
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url === releaseUrl('git/ref/heads/main')) {
      return jsonResponse({ object: { sha: commit } });
    }

    if (url === releaseUrl(`releases/tags/${tag}`)) {
      return notFound(); // GitHub's by-tag endpoint does not return draft releases.
    }

    if (url === releaseUrl('releases?per_page=100&page=1')) {
      return jsonResponse(created ? [githubRelease()] : []);
    }

    if (url === releaseUrl(`releases/${releaseId}`)) {
      return jsonResponse(githubRelease());
    }

    if (url === releaseUrl('releases/latest')) {
      return notFound();
    }

    throw new Error(`Unexpected GitHub request: ${url}`);
  };

  await publishRelease({
    commit,
    directory,
    fetchImpl,
    repository,
    runGh: (args) => {
      ghCalls.push(args);
      if (args[1] === 'create') {
        created = true;
      }
    },
    token: 'test-token',
  });

  assert.equal(requests[0], releaseUrl('git/ref/heads/main'));
  assert.deepEqual(ghCalls, [
    [
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--target',
      commit,
      '--draft',
      '--title',
      `Lead Desk ${metadata.version}`,
      '--notes-file',
      join(directory, 'release-notes.md'),
    ],
    [
      'release',
      'upload',
      tag,
      join(directory, 'lead-desk.tgz'),
      '--repo',
      repository,
    ],
    [
      'release',
      'upload',
      tag,
      join(directory, 'lead-desk.json'),
      '--repo',
      repository,
    ],
    ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'],
  ]);
  assert.equal(ghCalls.flat().includes('--clobber'), false);
});

test('publishRelease makes no GitHub mutations for superseded main or an existing published tag', async (context) => {
  await context.test('superseded main', async (subcontext) => {
    const { directory } = await artifact(subcontext);
    const ghCalls = [];
    await publishRelease({
      commit,
      directory,
      fetchImpl: async (url) => {
        assert.equal(url, releaseUrl('git/ref/heads/main'));
        return jsonResponse({ object: { sha: priorCommit } });
      },
      repository,
      runGh: (args) => ghCalls.push(args),
      token: 'test-token',
    });
    assert.deepEqual(ghCalls, []);
  });

  await context.test('published tag', async (subcontext) => {
    const { directory } = await artifact(subcontext);
    const ghCalls = [];
    await publishRelease({
      commit,
      directory,
      fetchImpl: async (url) => {
        if (url === releaseUrl('git/ref/heads/main')) {
          return jsonResponse({ object: { sha: commit } });
        }

        assert.equal(url, releaseUrl(`releases/tags/${tag}`));
        return jsonResponse(githubRelease({ draft: false }));
      },
      repository,
      runGh: (args) => ghCalls.push(args),
      token: 'test-token',
    });
    assert.deepEqual(ghCalls, []);
  });
});

test('publishRelease rejects a rewritten migration before creating a release', async (context) => {
  const { directory } = await artifact(context);
  const ghCalls = [];
  const previousTag = `build-${priorCommit}`;
  const previous = manifest({
    commit: priorCommit,
    migrations: [{ name: '0001_initial.sql', sha256: priorMigrationDigest }],
  });
  const fetchImpl = async (url) => {
    if (url === releaseUrl('git/ref/heads/main')) {
      return jsonResponse({ object: { sha: commit } });
    }

    if (url === releaseUrl(`releases/tags/${tag}`)) {
      return notFound();
    }

    if (url === releaseUrl('releases?per_page=100&page=1')) {
      return jsonResponse([]);
    }

    if (url === releaseUrl('releases/latest')) {
      return jsonResponse(
        githubRelease({
          assets: [
            { name: 'lead-desk.tgz', state: 'uploaded' },
            { name: 'lead-desk.json', state: 'uploaded' },
          ],
          draft: false,
          tag_name: previousTag,
        }),
      );
    }

    if (
      url ===
      `https://github.com/${repository}/releases/download/${previousTag}/lead-desk.json`
    ) {
      return jsonResponse(previous);
    }

    throw new Error(`Unexpected GitHub request: ${url}`);
  };

  await assert.rejects(
    publishRelease({
      commit,
      directory,
      fetchImpl,
      repository,
      runGh: (args) => ghCalls.push(args),
      token: 'test-token',
    }),
    /removed or rewritten/iu,
  );
  assert.deepEqual(ghCalls, []);
});

test('publishRelease rejects a mismatched pre-existing draft asset without mutation', async (context) => {
  const { directory } = await artifact(context);
  const ghCalls = [];
  const fetchImpl = async (url) => {
    if (url === releaseUrl('git/ref/heads/main')) {
      return jsonResponse({ object: { sha: commit } });
    }

    if (url === releaseUrl(`releases/tags/${tag}`)) {
      return notFound();
    }

    if (url === releaseUrl('releases?per_page=100&page=1')) {
      return jsonResponse([githubRelease()]);
    }

    if (url === releaseUrl(`releases/${releaseId}`)) {
      return jsonResponse(
        githubRelease({
          assets: [
            { digest: `sha256:${'f'.repeat(64)}`, name: 'lead-desk.tgz' },
          ],
        }),
      );
    }

    if (url === releaseUrl('releases/latest')) {
      return notFound();
    }

    throw new Error(`Unexpected GitHub request: ${url}`);
  };

  await assert.rejects(
    publishRelease({
      commit,
      directory,
      fetchImpl,
      repository,
      runGh: (args) => ghCalls.push(args),
      token: 'test-token',
    }),
    /existing draft asset differs/iu,
  );
  assert.deepEqual(ghCalls, []);
});

test('publishRelease stops when a draft is manually published before upload', async (context) => {
  const { directory } = await artifact(context);
  const ghCalls = [];
  let created = false;
  const fetchImpl = async (url) => {
    if (url === releaseUrl('git/ref/heads/main')) {
      return jsonResponse({ object: { sha: commit } });
    }

    if (url === releaseUrl(`releases/tags/${tag}`)) {
      return notFound();
    }

    if (url === releaseUrl('releases?per_page=100&page=1')) {
      return jsonResponse(created ? [githubRelease()] : []);
    }

    if (url === releaseUrl(`releases/${releaseId}`)) {
      return jsonResponse(githubRelease({ draft: false }));
    }

    if (url === releaseUrl('releases/latest')) {
      return notFound();
    }

    throw new Error(`Unexpected GitHub request: ${url}`);
  };

  await assert.rejects(
    publishRelease({
      commit,
      directory,
      fetchImpl,
      repository,
      runGh: (args) => {
        ghCalls.push(args);
        if (args[1] === 'create') {
          created = true;
        }
      },
      token: 'test-token',
    }),
    /changed state during publishing/iu,
  );
  assert.deepEqual(
    ghCalls.map((args) => args.slice(0, 2)),
    [['release', 'create']],
  );
});

test('publishRelease resumes a draft on a later listing page without recreating or overwriting assets', async (context) => {
  const { directory, metadata } = await artifact(context);
  const ghCalls = [];
  const requests = [];
  const draft = githubRelease({
    assets: [{ digest: `sha256:${metadata.sha256}`, name: 'lead-desk.tgz' }],
  });
  await publishRelease({
    commit,
    directory,
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      if (url === releaseUrl('git/ref/heads/main')) {
        return jsonResponse({ object: { sha: commit } });
      }

      if (url === releaseUrl(`releases/tags/${tag}`)) {
        return notFound();
      }

      if (url === releaseUrl('releases?per_page=100&page=1')) {
        return jsonResponse(
          Array.from({ length: 100 }, (_, index) =>
            githubRelease({
              draft: false,
              id: index + 1_000,
              tag_name: `other-${index}`,
            }),
          ),
        );
      }

      if (url === releaseUrl('releases?per_page=100&page=2')) {
        return jsonResponse([draft]);
      }

      if (url === releaseUrl(`releases/${releaseId}`)) {
        return jsonResponse(draft);
      }

      if (url === releaseUrl('releases/latest')) {
        return notFound();
      }

      throw new Error(`Unexpected GitHub request: ${url}`);
    },
    repository,
    runGh: (args) => ghCalls.push(args),
    token: 'test-token',
  });
  assert(requests.includes(releaseUrl('releases?per_page=100&page=2')));
  assert.deepEqual(ghCalls, [
    [
      'release',
      'upload',
      tag,
      join(directory, 'lead-desk.json'),
      '--repo',
      repository,
    ],
    ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'],
  ]);
});

test('publishRelease refuses an ID lookup that returns a different release tag', async (context) => {
  const { directory } = await artifact(context);
  const ghCalls = [];
  await assert.rejects(
    publishRelease({
      commit,
      directory,
      fetchImpl: async (url) => {
        if (url === releaseUrl('git/ref/heads/main')) {
          return jsonResponse({ object: { sha: commit } });
        }

        if (url === releaseUrl(`releases/tags/${tag}`)) {
          return notFound();
        }

        if (url === releaseUrl('releases?per_page=100&page=1')) {
          return jsonResponse([githubRelease()]);
        }

        if (url === releaseUrl(`releases/${releaseId}`)) {
          return jsonResponse(
            githubRelease({ tag_name: `build-${priorCommit}` }),
          );
        }

        if (url === releaseUrl('releases/latest')) {
          return notFound();
        }

        throw new Error(`Unexpected GitHub request: ${url}`);
      },
      repository,
      runGh: (args) => ghCalls.push(args),
      token: 'test-token',
    }),
    /changed state during publishing/iu,
  );
  assert.deepEqual(ghCalls, []);
});
