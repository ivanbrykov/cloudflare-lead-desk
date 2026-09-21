import {
  assertMigrationHistory,
  checksum,
  resolveRelease,
  validateManifest,
} from '../../templates/cloudflare/scripts/release.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

export const publishRelease = async ({
  commit,
  directory,
  fetchImpl = globalThis.fetch,
  repository,
  runGh = (args) =>
    execFileSync('gh', args, { stdio: 'inherit', timeout: 120_000 }),
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
  const api = async (path) => {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
        },
        signal: globalThis.AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 404) {
      return null;
    }

    assert(response.ok, `GitHub release API failed: HTTP ${response.status}`);
    return response.json();
  };

  const isCurrentMain = async () =>
    (await api('git/ref/heads/main'))?.object?.sha === manifest.commit;
  const findRelease = async (tag) => {
    const published = await api(`releases/tags/${tag}`);
    if (published) {
      return published;
    }

    // GitHub's by-tag endpoint only returns published releases. Authenticated
    // listings include drafts, including an interrupted upload from a prior run.
    for (let page = 1; ; page += 1) {
      const releases = await api(`releases?per_page=100&page=${page}`);
      assert(
        Array.isArray(releases),
        'Could not list releases to locate the draft.',
      );
      const found = releases.find((release) => release.tag_name === tag);
      if (found) {
        return found;
      }

      if (releases.length < 100) {
        return null;
      }
    }
  };

  const publish = async () => {
    if (!(await isCurrentMain())) {
      log('Skipping superseded main build; latest remains unchanged.');
      return;
    }

    const tag = `build-${manifest.commit}`;
    let existing = await findRelease(tag);
    if (existing && !existing.draft) {
      log(
        `Release ${tag} is already published; its assets will not be overwritten.`,
      );
      return;
    }

    if (await api('releases/latest')) {
      const previous = await resolveRelease({
        fetchImpl,
        repository,
        token,
      });
      assertMigrationHistory(previous.manifest, manifest);
    }

    const notes = join(directory, 'release-notes.md');
    await writeFile(
      notes,
      `Lead Desk ${manifest.version}\n\nSource commit: ${manifest.commit}\n\nThis is a tested build of main, consumed by templates configured to follow latest. Existing installations apply pending D1 migrations before deploying.\n\nArchive SHA-256: ${manifest.sha256}\n`,
    );
    const gh = runGh;
    if (!existing) {
      gh([
        'release',
        'create',
        tag,
        '--repo',
        repository,
        '--target',
        manifest.commit,
        '--draft',
        '--title',
        `Lead Desk ${manifest.version}`,
        '--notes-file',
        notes,
      ]);
      existing = await findRelease(tag);
    }

    assert(
      Number.isSafeInteger(existing?.id) && existing.id > 0,
      'Could not locate the created draft release by ID.',
    );
    const draftPath = `releases/${existing.id}`;

    // Never overwrite assets, even if a draft is manually published mid-upload.
    // Interrupted uploads can resume only when any existing assets match exactly.
    for (const asset of ['lead-desk.tgz', 'lead-desk.json']) {
      const draft = await api(draftPath);
      assert(
        draft?.draft && draft.tag_name === tag,
        'Release changed state during publishing; refusing to modify it.',
      );
      const uploaded = draft.assets?.find((entry) => entry.name === asset);
      if (uploaded) {
        assert.equal(
          uploaded.digest,
          `sha256:${checksum(await readFile(join(directory, asset)))}`,
          `Existing draft asset differs: ${asset}. Review and remove the draft before retrying.`,
        );
      } else {
        gh([
          'release',
          'upload',
          tag,
          join(directory, asset),
          '--repo',
          repository,
        ]);
      }
    }

    if (!(await isCurrentMain())) {
      log(
        'Main advanced during upload; leaving the superseded release as a draft.',
      );
      return;
    }

    const ready = await api(draftPath);
    assert(
      ready?.draft && ready.tag_name === tag,
      'Release was published externally; refusing to change latest.',
    );
    gh([
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--draft=false',
      '--latest',
    ]);
  };

  await publish();
};

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  // Only the upstream main workflow can invoke the real publishing command.
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
