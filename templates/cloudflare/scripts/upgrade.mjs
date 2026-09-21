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

export const validateUpgradeCandidate = async ({
  expectedConfiguration,
  repositoryUrl,
  root: installationRoot,
  targetRevision,
}) => {
  const root = resolve(installationRoot);
  const configurationPath = join(root, 'lead-desk.json');
  const configuration = validateConfiguration(
    JSON.parse(await readFile(configurationPath, 'utf8')),
  );
  if (expectedConfiguration) {
    assert.deepEqual(
      configuration,
      validateConfiguration(expectedConfiguration),
      'Tracked source configuration changed after resolution',
    );
  }

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
    return {
      changed: false,
      configuration,
      newRevision: revision,
      oldRevision: revision,
    };
  }

  const receipt = await prepareSource({
    baselineConfiguration: configuration,
    configuration: { ...configuration, revision },
    repositoryUrl,
    root,
  });
  assert.equal(
    receipt.commit,
    revision,
    'Validated source does not match the candidate revision',
  );
  log(`Validated Lead Desk candidate ${revision}`);
  return {
    changed: true,
    configuration,
    newRevision: revision,
    oldRevision: configuration.revision,
  };
};

export const upgradePin = async (options) => {
  const result = await validateUpgradeCandidate(options);
  if (!result.changed) {
    return {
      changed: false,
      newRevision: result.newRevision,
      oldRevision: result.oldRevision,
    };
  }

  await writeFile(
    join(resolve(options.root), 'lead-desk.json'),
    `${JSON.stringify(
      { ...result.configuration, revision: result.newRevision },
      undefined,
      2,
    )}\n`,
  );
  log(`Source pin is ready to commit at ${result.newRevision}`);
  return {
    changed: true,
    newRevision: result.newRevision,
    oldRevision: result.oldRevision,
  };
};

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'Run upgrades through the installation repository workflow',
  );
  const root = process.cwd();
  const baseSha = process.env.LEAD_DESK_BASE_SHA;
  const expectedConfiguration = {
    repository: process.env.LEAD_DESK_OLD_REPOSITORY,
    revision: process.env.LEAD_DESK_OLD_REVISION,
  };
  const targetRevision = process.env.LEAD_DESK_TARGET_REVISION;
  assert.match(baseSha ?? '', /^[a-f0-9]{40}$/u, 'Invalid base commit');
  assert.equal(
    gitOutput(['rev-parse', 'HEAD'], root).trim(),
    baseSha,
    'Validation checkout does not match the resolved base commit',
  );
  assert.equal(
    gitOutput(['status', '--porcelain', '--untracked-files=no'], root),
    '',
    'Installation has tracked changes before upgrade',
  );
  const configuration = validateConfiguration(expectedConfiguration);
  assert(
    process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_REPOSITORY !== configuration.repository,
    'Refusing to run the installation updater in the upstream source repository',
  );
  assert.match(
    targetRevision ?? '',
    /^[a-f0-9]{40}$/u,
    'Invalid target revision',
  );
  const result = await validateUpgradeCandidate({
    expectedConfiguration: configuration,
    root,
    targetRevision,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `- Candidate validation: ${result.changed ? 'passed' : 'not required'}\n`,
    );
  }
}
