import {
  api,
  assertActorCanUpgrade,
  readConfiguration,
  repositoryPattern,
  shaPattern,
  upstream,
} from './github.mjs';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import process from 'node:process';

export const commitUpgrade = async (
  {
    actorId,
    actorLogin,
    baseSha,
    branch,
    oldRevision,
    repository,
    repositoryId,
    targetRevision,
    token,
  },
  fetchImpl,
) => {
  assert(repositoryPattern.test(repository));
  assert.notEqual(repository, upstream);
  assert(shaPattern.test(baseSha));
  assert(shaPattern.test(oldRevision));
  assert(shaPattern.test(targetRevision));
  assert.notEqual(oldRevision, targetRevision, 'Already current');
  const repo = await api(`/repos/${repository}`, { fetchImpl, token });
  assert.equal(repo.id, repositoryId, 'Target repository ID changed');
  assert.equal(repo.full_name, repository, 'Target repository renamed');
  assert.equal(repo.default_branch, branch, 'Default branch changed');
  await assertActorCanUpgrade({
    actorId,
    actorLogin,
    fetchImpl,
    repository,
    token,
  });
  const path = `/repos/${repository}`;
  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  const readRefPath = `${path}/git/ref/heads/${branchPath}`;
  const writeRefPath = `${path}/git/refs/heads/${branchPath}`;
  const currentRef = await api(readRefPath, { fetchImpl, token });
  assert.equal(currentRef.object?.sha, baseSha, 'Default branch advanced');
  const config = await readConfiguration(repository, token, baseSha, fetchImpl);
  assert.equal(config.revision, oldRevision, 'Installation pin changed');
  const baseCommit = await api(`${path}/git/commits/${baseSha}`, {
    fetchImpl,
    token,
  });
  assert(shaPattern.test(baseCommit.tree?.sha));
  const blob = await api(`${path}/git/blobs`, {
    body: {
      content: `${JSON.stringify({ repository: upstream, revision: targetRevision }, undefined, 2)}\n`,
      encoding: 'utf8',
    },
    fetchImpl,
    method: 'POST',
    token,
  });
  const tree = await api(`${path}/git/trees`, {
    body: {
      base_tree: baseCommit.tree.sha,
      tree: [
        { mode: '100644', path: 'lead-desk.json', sha: blob.sha, type: 'blob' },
      ],
    },
    fetchImpl,
    method: 'POST',
    token,
  });
  assert(shaPattern.test(tree.sha));
  const next = await api(`${path}/git/commits`, {
    body: {
      message: `chore: upgrade Lead Desk source to ${targetRevision.slice(0, 12)}`,
      parents: [baseSha],
      tree: tree.sha,
    },
    fetchImpl,
    method: 'POST',
    token,
  });
  assert(shaPattern.test(next.sha));
  const finalRef = await api(readRefPath, { fetchImpl, token });
  assert.equal(finalRef.object?.sha, baseSha, 'Default branch advanced');
  await api(writeRefPath, {
    body: { force: false, sha: next.sha },
    fetchImpl,
    method: 'PATCH',
    token,
  });
  return next.sha;
};

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  assert.equal(process.env.GITHUB_REPOSITORY, upstream);
  const sha = await commitUpgrade({
    actorId: Number(process.env.ACTOR_ID),
    actorLogin: process.env.ACTOR_LOGIN,
    baseSha: process.env.BASE_SHA,
    branch: process.env.DEFAULT_BRANCH,
    oldRevision: process.env.OLD_REVISION,
    repository: process.env.TARGET_REPOSITORY,
    repositoryId: Number(process.env.TARGET_REPOSITORY_ID),
    targetRevision: process.env.TARGET_REVISION,
    token: process.env.TARGET_WRITE_TOKEN,
  });
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `- Pin-only commit: \`${sha}\`\n`,
  );
}
