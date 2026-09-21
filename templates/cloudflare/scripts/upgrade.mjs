import { prepareSource } from './build.mjs';
import { githubRepositoryUrl, validateConfiguration } from './source.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const gitOutput = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });

export const resolveUpstreamMain = ({ repository, repositoryUrl, root }) => {
  const output = gitOutput(
    [
      '-c',
      'http.https://github.com/.extraheader=',
      'ls-remote',
      '--exit-code',
      repositoryUrl ?? githubRepositoryUrl(repository),
      'refs/heads/main',
    ],
    root,
  ).trim();
  const match = /^([a-f0-9]{40})\trefs\/heads\/main$/u.exec(output);
  assert(match, 'Upstream main did not resolve to exactly one commit');
  return match[1];
};

export const upgradePin = async ({
  repositoryUrl,
  root: installationRoot,
  targetRevision,
}) => {
  const root = resolve(installationRoot);
  const configurationPath = join(root, 'lead-desk.json');
  const configuration = validateConfiguration(
    JSON.parse(await readFile(configurationPath, 'utf8')),
  );
  const revision =
    targetRevision ??
    resolveUpstreamMain({
      repository: configuration.repository,
      repositoryUrl,
      root,
    });
  assert.match(revision, /^[a-f0-9]{40}$/u, 'Invalid candidate revision');
  if (revision === configuration.revision) {
    log(`Lead Desk is already current at ${revision}`);
    return { changed: false, newRevision: revision, oldRevision: revision };
  }

  const receipt = await prepareSource({
    configuration: { ...configuration, revision },
    repositoryUrl,
    root,
  });
  assert.equal(
    receipt.commit,
    revision,
    'Validated source does not match the candidate revision',
  );
  await writeFile(
    configurationPath,
    `${JSON.stringify({ ...configuration, revision }, undefined, 2)}\n`,
  );
  log(`Validated Lead Desk ${revision}; source pin is ready to commit`);
  return {
    changed: true,
    newRevision: revision,
    oldRevision: configuration.revision,
  };
};

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'Run upgrades through the installation repository workflow',
  );
  const root = process.cwd();
  const defaultBranch = process.env.LEAD_DESK_DEFAULT_BRANCH;
  assert(defaultBranch, 'Missing installation default branch');
  assert.equal(
    gitOutput(['branch', '--show-current'], root).trim(),
    defaultBranch,
    'Upgrade checkout is not on the installation default branch',
  );
  assert.equal(
    gitOutput(['status', '--porcelain', '--untracked-files=no'], root),
    '',
    'Installation has tracked changes before upgrade',
  );
  const configuration = validateConfiguration(
    JSON.parse(await readFile(join(root, 'lead-desk.json'), 'utf8')),
  );
  assert(
    process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_REPOSITORY !== configuration.repository,
    'Refusing to run the installation updater in the upstream source repository',
  );
  const result = await upgradePin({ root });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Lead Desk upgrade\n\n- Previous source: \`${result.oldRevision}\`\n- Candidate source: \`${result.newRevision}\`\n- Pin changed: ${result.changed ? 'yes' : 'no'}\n`,
    );
  }
}
