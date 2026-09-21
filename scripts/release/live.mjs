import {
  checksum,
  validateManifest,
} from '../../templates/cloudflare/scripts/release.mjs';
import { createReleaseClient } from './github.mjs';
import { uploadReleaseAssets } from './publish.mjs';
import assert from 'node:assert/strict';
import { log } from 'node:console';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

// Explicit CI diagnostic: exercise the real API/token, but NEVER publish a release.
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.equal(process.env.GITHUB_REPOSITORY, 'ivanbrykov/cloudflare-lead-desk');
assert.equal(process.env.LEAD_DESK_RELEASE_API_SMOKE, 'true');
assert(/^\d+$/u.test(process.env.GITHUB_RUN_ID ?? ''));
assert(/^\d+$/u.test(process.env.GITHUB_RUN_ATTEMPT ?? ''));
const directory = resolve(process.argv[2] ?? '.release');
const manifest = validateManifest(
  JSON.parse(await readFile(join(directory, 'lead-desk.json'), 'utf8')),
);
assert.equal(manifest.commit, process.env.GITHUB_SHA);
assert.equal(
  checksum(await readFile(join(directory, 'lead-desk.tgz'))),
  manifest.sha256,
);
const client = createReleaseClient({
  repository: process.env.GITHUB_REPOSITORY,
  token: process.env.GH_TOKEN,
});
const tag = `release-api-smoke-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
let created;
let failure;
try {
  created = await client.createDraft({
    body: 'Temporary CI draft. Never publish. Automatically removed after the API check.',
    // Like production, target main. A review-branch target that changes workflows
    // needs extra GitHub workflow-write permission unavailable to GITHUB_TOKEN.
    commit: 'main',
    name: `Disposable release API check ${process.env.GITHUB_RUN_ID}`,
    tag,
  });
  log(`Created disposable draft ${created.id} directly from the API response`);
  await uploadReleaseAssets({ client, directory, id: created.id, tag });
  // Verify authenticated recovery of existing assets without replacement.
  await uploadReleaseAssets({ client, directory, id: created.id, tag });
  const draft = await client.readDraft(created.id, tag);
  assert.deepEqual(draft.assets.map((asset) => asset.name).toSorted(), [
    'lead-desk.json',
    'lead-desk.tgz',
  ]);
  log(
    `PASS: draft ${created.id}, both uploaded asset digests, and non-overwriting resume verified with GITHUB_TOKEN`,
  );
} catch (error) {
  failure = error;
} finally {
  if (created) {
    // Only remove the exact draft this invocation created, and only while still a draft.
    try {
      await client.readDraft(created.id, tag);
      await client.api(`releases/${created.id}`, { method: 'DELETE' });
      log(`Removed disposable draft ${created.id}; no release was published`);
    } catch (error) {
      log(
        `Cleanup failed for disposable draft ${created.id}: ${error.message}`,
      );
      failure ??= error;
    }
  }
}

if (failure) {
  throw failure;
}
