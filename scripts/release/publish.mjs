import {
  assertMigrationHistory,
  checksum,
  resolveRelease,
  validateManifest,
} from '../../templates/cloudflare/scripts/release.mjs';
import { createReleaseClient } from './github.mjs';
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

export const uploadReleaseAssets = async ({ client, directory, id, tag }) => {
  for (const name of ['lead-desk.tgz', 'lead-desk.json']) {
    const draft = await client.readDraft(id, tag);
    const bytes = await readFile(join(directory, name));
    const digest = `sha256:${checksum(bytes)}`;
    const existing = draft.assets?.find((asset) => asset.name === name);
    if (existing) {
      assert.equal(
        existing.digest,
        digest,
        `Existing draft asset differs: ${name}. Review and remove the draft before retrying.`,
      );
      assert.equal(
        existing.state,
        'uploaded',
        `Draft asset upload is incomplete: ${name}`,
      );
    } else {
      // POSTing a duplicate name fails on GitHub; there is no delete/clobber path.
      const uploaded = await client.uploadAsset(id, name, bytes);
      assert.equal(uploaded.name, name);
      assert.equal(uploaded.state, 'uploaded');
      assert.equal(uploaded.size, bytes.length);
      assert.equal(
        uploaded.digest,
        digest,
        `Uploaded asset checksum mismatch: ${name}`,
      );
    }
  }
};

export const publishRelease = async ({
  commit,
  directory,
  fetchImpl = globalThis.fetch,
  repository,
  token,
}) => {
  const manifest = validateManifest(
    JSON.parse(await readFile(join(directory, 'lead-desk.json'), 'utf8')),
  );
  assert.equal(
    manifest.commit,
    commit,
    'Artifact is not from this workflow commit',
  );
  assert.equal(
    checksum(await readFile(join(directory, 'lead-desk.tgz'))),
    manifest.sha256,
    'Artifact checksum mismatch',
  );
  const client = createReleaseClient({ fetchImpl, repository, token });
  const isCurrentMain = async () =>
    (await client.api('git/ref/heads/main'))?.object?.sha === manifest.commit;
  if (!(await isCurrentMain())) {
    log('Skipping superseded main build; latest remains unchanged.');
    return;
  }

  const tag = `build-${manifest.commit}`;
  let release = await client.findRelease(tag);
  if (release && !release.draft) {
    log(
      `Release ${tag} is already published; its assets will not be overwritten.`,
    );
    return;
  }

  if (await client.api('releases/latest')) {
    const previous = await resolveRelease({ fetchImpl, repository, token });
    assertMigrationHistory(previous.manifest, manifest);
  }

  if (!release) {
    release = await client.createDraft({
      body: `Lead Desk ${manifest.version}\n\nSource commit: ${manifest.commit}\n\nTested main build for installations following latest. Apply pending D1 migrations before deploying.\n\nArchive SHA-256: ${manifest.sha256}\n`,
      commit: manifest.commit,
      name: `Lead Desk ${manifest.version}`,
      tag,
    });
  }

  await uploadReleaseAssets({ client, directory, id: release.id, tag });
  if (!(await isCurrentMain())) {
    log(
      'Main advanced during upload; leaving the superseded release as a draft.',
    );
    return;
  }

  await client.readDraft(release.id, tag);
  const published = await client.api(`releases/${release.id}`, {
    body: { draft: false, make_latest: 'true' },
    method: 'PATCH',
  });
  assert.equal(published.id, release.id);
  assert.equal(published.tag_name, tag);
  assert.equal(published.draft, false);
  log(`Published ${tag}`);
};

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(
    process.env.GITHUB_REPOSITORY,
    'ivanbrykov/cloudflare-lead-desk',
  );
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert(['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME));
  assert(process.env.GH_TOKEN, 'Missing release publishing token');
  await publishRelease({
    commit: process.env.GITHUB_SHA,
    directory: resolve(process.argv[2] ?? '.release'),
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
}
