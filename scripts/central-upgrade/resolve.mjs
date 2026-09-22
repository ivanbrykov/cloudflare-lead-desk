import {
  api,
  assertActorCanUpgrade,
  installationToken,
  readConfiguration,
  repositoryPattern,
  shaPattern,
  upstream,
} from './github.mjs';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import process from 'node:process';

export const resolveUpgrade = async ({
  actorId,
  actorLogin,
  appId,
  fetchImpl,
  privateKey,
  repository,
  repositoryId,
  targetRevision,
}) => {
  assert(repositoryPattern.test(repository), 'Invalid target repository');
  assert.notEqual(repository, upstream, 'Cannot update the source repository');
  assert(shaPattern.test(targetRevision), 'Invalid upstream commit');
  const readToken = await installationToken({
    appId,
    fetchImpl,
    permission: 'read',
    privateKey,
    repository,
    repositoryId,
  });
  const target = await api(`/repos/${repository}`, {
    fetchImpl,
    token: readToken,
  });
  assert.equal(target.id, repositoryId, 'Target repository ID changed');
  assert.equal(target.full_name, repository, 'Target repository renamed');
  const branch = target.default_branch;
  assert(branch && branch.length <= 200, 'Invalid default branch');
  const ref = await api(
    `/repos/${repository}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
    { fetchImpl, token: readToken },
  );
  assert(shaPattern.test(ref.object?.sha), 'Invalid installation base commit');
  await assertActorCanUpgrade({
    actorId,
    actorLogin,
    fetchImpl,
    repository,
    token: readToken,
  });
  const configuration = await readConfiguration(
    repository,
    readToken,
    ref.object.sha,
    fetchImpl,
  );
  return {
    actorId,
    actorLogin,
    baseSha: ref.object.sha,
    branch,
    oldRevision: configuration.revision,
    repository,
    repositoryId,
    targetRevision,
  };
};

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  assert.equal(process.env.GITHUB_REPOSITORY, upstream);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const result = await resolveUpgrade({
    actorId: Number(process.env.INPUT_ACTOR_ID),
    actorLogin: process.env.INPUT_ACTOR_LOGIN,
    appId: process.env.LEAD_DESK_APP_ID,
    privateKey: process.env.LEAD_DESK_APP_PRIVATE_KEY,
    repository: process.env.INPUT_TARGET_REPOSITORY,
    repositoryId: Number(process.env.INPUT_TARGET_REPOSITORY_ID),
    targetRevision: process.env.GITHUB_SHA,
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(result)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Lead Desk upgrade\n\n- Installation: ${result.repository}\n- Previous source: \`${result.oldRevision}\`\n- Candidate source: \`${result.targetRevision}\`\n`,
  );
}
