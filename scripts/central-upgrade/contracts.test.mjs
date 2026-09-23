import { commitUpgrade } from './commit.mjs';
import { resolveUpgrade } from './resolve.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repository = 'owner/installation';
const baseSha = 'a'.repeat(40);
const oldRevision = 'b'.repeat(40);
const targetRevision = 'c'.repeat(40);
const nextSha = 'd'.repeat(40);
const treeSha = 'e'.repeat(40);
const blobSha = 'f'.repeat(40);
const config = {
  repository: 'ivanbrykov/cloudflare-lead-desk',
  revision: oldRevision,
};

const response = (value) => globalThis.Response.json(value);

const commitFixture = ({ advanceAt = -1, revision = oldRevision } = {}) => {
  const requests = [];
  let refReads = 0;
  const fetchImpl = async (url, options) => {
    const path = new globalThis.URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ body, method: options.method, path });
    if (path === `/repos/${repository}`) {
      return response({
        default_branch: 'release/custom',
        full_name: repository,
        id: 42,
      });
    }

    if (path === '/users/owner') {
      return response({ id: 7 });
    }

    if (path.endsWith('/collaborators/owner/permission')) {
      return response({ permission: 'write' });
    }

    if (path.endsWith('/git/ref/heads/release/custom')) {
      refReads += 1;
      return response({
        object: { sha: refReads === advanceAt ? nextSha : baseSha },
      });
    }

    if (path.endsWith('/git/refs/heads/release/custom')) {
      if (options.method === 'PATCH') {
        return response({ object: { sha: nextSha } });
      }

      throw new Error('A write-reference endpoint may not be used for reads');
    }

    if (path.endsWith('/contents/lead-desk.json')) {
      return response({
        content: Buffer.from(JSON.stringify({ ...config, revision })).toString(
          'base64',
        ),
        encoding: 'base64',
      });
    }

    if (path.endsWith(`/git/commits/${baseSha}`)) {
      return response({ tree: { sha: treeSha } });
    }

    if (path.endsWith('/git/blobs')) {
      return response({ sha: blobSha });
    }

    if (path.endsWith('/git/trees')) {
      return response({ sha: treeSha });
    }

    if (path.endsWith('/git/commits')) {
      return response({ sha: nextSha });
    }

    throw new Error(`Unexpected ${options.method} ${path}`);
  };

  return { fetchImpl, requests };
};

const input = {
  actorId: 7,
  actorLogin: 'owner',
  baseSha,
  branch: 'release/custom',
  oldRevision,
  repository,
  repositoryId: 42,
  targetRevision,
  token: 'sentinel',
};

test('candidate validation and trusted write remain isolated hosted jobs', async () => {
  const workflow = await readFile(
    resolve(
      import.meta.dirname,
      '../../.github/workflows/cloudflare-upgrade.yml',
    ),
    'utf8',
  );
  const validate = workflow
    .split('\n  validate:\n')[1]
    ?.split('\n  commit:\n')[0];
  const commit = workflow.split('\n  commit:\n')[1];
  assert(validate && commit, 'Both isolated jobs must exist');
  assert.match(workflow, /permissions:\n {2}contents: read/u);
  assert.doesNotMatch(
    validate,
    /TARGET_PERMISSION: write|contents: write|write-token/u,
  );
  assert.match(validate, /persist-credentials: false/u);
  assert.match(commit, /runs-on: ubuntu-latest/u);
  assert.match(commit, /TARGET_PERMISSION: write/u);
  assert.doesNotMatch(
    commit,
    /consumer|prepareSource|pnpm|download-artifact|upload-artifact|cache/iu,
  );
  assert.match(commit, /run: node scripts\/central-upgrade\/commit\.mjs/u);
  assert.doesNotMatch(workflow, /uses: [^\n]+@v\d/u);
  for (const sha of [
    '11d5960a326750d5838078e36cf38b85af677262',
    '49933ea5288caeca8642d1e84afbd3f7d6820020',
    'b906affcce14559ad1aafd4ab0e942779e9f58b1',
  ]) {
    assert.match(workflow, new RegExp(sha, 'u'));
  }
});

test('trusted write creates a single-path pin commit and never force-pushes', async () => {
  const fixture = commitFixture();
  assert.equal(await commitUpgrade(input, fixture.fetchImpl), nextSha);
  const writes = fixture.requests.filter((request) =>
    ['PATCH', 'POST'].includes(request.method),
  );
  assert.deepEqual(
    writes.map((request) => request.path),
    [
      `/repos/${repository}/git/blobs`,
      `/repos/${repository}/git/trees`,
      `/repos/${repository}/git/commits`,
      `/repos/${repository}/git/refs/heads/release/custom`,
    ],
  );
  assert.deepEqual(writes[1].body, {
    base_tree: treeSha,
    tree: [
      { mode: '100644', path: 'lead-desk.json', sha: blobSha, type: 'blob' },
    ],
  });
  assert.deepEqual(JSON.parse(writes[0].body.content), {
    ...config,
    revision: targetRevision,
  });
  assert.deepEqual(writes[2].body.parents, [baseSha]);
  assert.deepEqual(writes[3].body, { force: false, sha: nextSha });
});

test('changed base or pin blocks every write', async () => {
  for (const fixture of [
    commitFixture({ advanceAt: 1 }),
    commitFixture({ revision: targetRevision }),
  ]) {
    await assert.rejects(commitUpgrade(input, fixture.fetchImpl));
    assert.equal(
      fixture.requests.some((request) =>
        ['PATCH', 'POST'].includes(request.method),
      ),
      false,
    );
  }
});

test('race immediately before push blocks ref update', async () => {
  const fixture = commitFixture({ advanceAt: 2 });
  await assert.rejects(
    commitUpgrade(input, fixture.fetchImpl),
    /Default branch advanced/u,
  );
  assert.equal(
    fixture.requests.some((request) => request.method === 'PATCH'),
    false,
  );
});

test('same revision is a no-op before any request', async () => {
  const fixture = commitFixture();
  await assert.rejects(
    commitUpgrade({ ...input, targetRevision: oldRevision }, fixture.fetchImpl),
    /Already current/u,
  );
  assert.equal(fixture.requests.length, 0);
});

test('resolver binds requester, repository id, custom default branch and old pin', async () => {
  const fixture = commitFixture();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  const fetchImpl = async (url, options) => {
    const path = new globalThis.URL(url).pathname;
    if (path === `/repos/${repository}/installation`) {
      return response({ id: 99 });
    }

    if (path === '/app/installations/99/access_tokens') {
      assert.deepEqual(JSON.parse(options.body), {
        permissions: { contents: 'read' },
        repository_ids: [42],
      });
      return response({ token: 'sentinel' });
    }

    return fixture.fetchImpl(url, options);
  };

  const result = await resolveUpgrade({
    ...input,
    appId: '123',
    fetchImpl,
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs1' }).toString(),
  });
  assert.deepEqual(result, {
    actorId: 7,
    actorLogin: 'owner',
    baseSha,
    branch: 'release/custom',
    oldRevision,
    repository,
    repositoryId: 42,
    targetRevision,
  });
});
