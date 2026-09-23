import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const callerPath = join(root, 'templates/cloudflare/upgrade-workflow.yml');
const reusablePath = join(root, '.github/workflows/cloudflare-upgrade.yml');
const oldRevision = 'b'.repeat(40);
const baseSha = 'a'.repeat(40);
const targetRevision = 'c'.repeat(40);

const trustedWriteScript = (workflow) => {
  const job = workflow.indexOf('\n  commit:\n');
  assert.notEqual(job, -1, 'Reusable workflow needs an isolated commit job');
  const marker = '        run: |\n';
  const start = workflow.indexOf(marker, job);
  assert.notEqual(start, -1, 'Commit job needs an inline trusted write step');
  return workflow
    .slice(start + marker.length)
    .split('\n')
    .map((line) => {
      assert(line === '' || line.startsWith('          '));
      return line.slice(10);
    })
    .join('\n');
};

const runTrustedWrite = async (
  context,
  script,
  { changedPaths = 'lead-desk.json', remoteSha = baseSha } = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-desk-reusable-write-'));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const binaryDirectory = join(directory, 'bin');
  await mkdir(binaryDirectory);
  const fakeGit = join(binaryDirectory, 'git');
  await writeFile(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_GIT_TRACE"
case "$1" in
  check-ref-format|init|remote|fetch|read-tree|update-index)
    exit 0
    ;;
  rev-parse)
    if [[ "$2" == refs/remotes/origin/* ]]; then
      printf '%s\\n' "$BASE_SHA"
    else
      printf '%040d\\n' 1
    fi
    ;;
  show)
    cat "$MOCK_ORIGINAL_CONFIG"
    ;;
  ls-tree)
    printf '100644 blob %040d\\tlead-desk.json\\n' 2
    ;;
  hash-object)
    printf '%040d\\n' 3
    ;;
  write-tree)
    printf '%040d\\n' 4
    ;;
  commit-tree)
    cat >/dev/null
    printf '%040d\\n' 5
    ;;
  diff-tree)
    printf '%b\\n' "$MOCK_CHANGED_PATHS"
    ;;
  ls-remote)
    printf '%s\\trefs/heads/%s\\n' "$MOCK_REMOTE_SHA" "$DEFAULT_BRANCH"
    ;;
  push)
    : > "$MOCK_PUSH_MARKER"
    ;;
  *)
    printf 'unexpected git command: %s\\n' "$*" >&2
    exit 97
    ;;
esac
`,
  );
  await chmod(fakeGit, 0o755);
  const originalConfig = join(directory, 'original.json');
  await writeFile(
    originalConfig,
    `${JSON.stringify({
      repository: 'ivanbrykov/cloudflare-lead-desk',
      revision: oldRevision,
    })}\n`,
  );
  const scriptPath = join(directory, 'trusted-write.sh');
  const summaryPath = join(directory, 'summary.md');
  const tracePath = join(directory, 'git.log');
  const pushMarker = join(directory, 'pushed');
  await writeFile(scriptPath, script);
  const environment = {
    ...process.env,
    BASE_SHA: baseSha,
    DEFAULT_BRANCH: 'trunk',
    GITHUB_STEP_SUMMARY: summaryPath,
    INSTALLATION_REPOSITORY: 'customer/installation',
    MOCK_CHANGED_PATHS: changedPaths,
    MOCK_GIT_TRACE: tracePath,
    MOCK_ORIGINAL_CONFIG: originalConfig,
    MOCK_PUSH_MARKER: pushMarker,
    MOCK_REMOTE_SHA: remoteSha,
    OLD_REPOSITORY: 'ivanbrykov/cloudflare-lead-desk',
    OLD_REVISION: oldRevision,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    REPOSITORY_WRITE_TOKEN: 'fake-write-credential',
    RUNNER_TEMP: directory,
    TARGET_REVISION: targetRevision,
  };
  let error;
  try {
    execFileSync('bash', [scriptPath], {
      cwd: directory,
      env: environment,
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch (error_) {
    error = error_;
  }

  return {
    error,
    pushed: await readFile(pushMarker, 'utf8').then(
      () => true,
      () => false,
    ),
    trace: await readFile(tracePath, 'utf8'),
  };
};

test('copied README installs the exact small caller in its own repository', async () => {
  const [caller, readme] = await Promise.all([
    readFile(callerPath, 'utf8'),
    readFile(join(root, 'templates/cloudflare/README.md'), 'utf8'),
  ]);
  assert.match(caller, /workflow_dispatch:/u);
  assert.match(caller, /contents: write/u);
  assert.match(
    caller,
    /uses: ivanbrykov\/cloudflare-lead-desk\/\.github\/workflows\/cloudflare-upgrade\.yml@main/u,
  );
  assert.doesNotMatch(caller, /run:|secrets:|checkout@/u);
  const install = /\[install the Upgrade workflow\]\(([^)]+)\)/u.exec(readme);
  assert(install);
  const installUrl = new URL(
    install[1],
    'https://github.com/customer/installation/blob/main/README.md',
  );
  assert.equal(installUrl.pathname, '/customer/installation/new/main');
  assert.equal(
    installUrl.searchParams.get('filename'),
    '.github/workflows/upgrade.yml',
  );
  assert.equal(installUrl.searchParams.get('value'), caller);
  assert.match(readme, /\[the small workflow file\]\(upgrade-workflow\.yml\)/u);
  const button = /\[!\[Upgrade Lead Desk\]\([^)]+\)\]\(([^)]+)\)/u.exec(readme);
  assert(button);
  assert.equal(
    new URL(
      button[1],
      'https://github.com/customer/installation/blob/main/README.md',
    ).pathname,
    '/customer/installation/actions/workflows/upgrade.yml',
  );
  await assert.rejects(
    readFile(join(root, 'templates/cloudflare/.github/workflows/upgrade.yml')),
    { code: 'ENOENT' },
  );
});

test('reusable upgrade keeps candidate code away from write authority', async () => {
  const workflow = await readFile(reusablePath, 'utf8');
  const commitJob = workflow.indexOf('\n  commit:\n');
  assert.match(workflow, /^on:\n {2}workflow_call:/mu);
  assert.match(workflow, /github\.event\.repository\.default_branch/u);
  assert.match(workflow, /baselineConfiguration: configuration/u);
  assert.match(workflow, /prepareSource\(/u);
  assert.match(workflow, /Candidate must descend from the current pin/u);
  assert.match(workflow, /Candidate upstream main CI has not passed/u);
  assert.match(workflow, /git fetch --no-auto-maintenance/u);
  assert.match(workflow, /REPOSITORY_WRITE_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.notEqual(commitJob, -1);
  assert.doesNotMatch(
    workflow.slice(0, commitJob),
    /contents: write|upload-artifact|download-artifact|cache/iu,
  );
  const validateJob = workflow.slice(
    workflow.indexOf('\n  validate:\n'),
    commitJob,
  );
  assert.doesNotMatch(
    validateJob,
    /github\.token|GITHUB_READ_TOKEN|REPOSITORY_WRITE_TOKEN/u,
  );
  assert.doesNotMatch(workflow.slice(commitJob), /uses:|node scripts\/|pnpm /u);
  assert.equal(workflow.match(/contents: write/gu)?.length, 1);
  assert.equal(workflow.match(/persist-credentials: false/gu)?.length, 2);
  assert.match(
    workflow,
    /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/u,
  );
  assert.match(
    workflow,
    /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/u,
  );
  assert.match(
    workflow,
    /pnpm\/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1/u,
  );
  assert.doesNotMatch(workflow, /uses: [^\n]+@v\d/u);
  const nodeBlocks = [
    ...workflow.matchAll(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE/gu,
    ),
  ];
  assert.equal(nodeBlocks.length, 3);
  for (const [, body] of nodeBlocks) {
    const source = body.replaceAll(/^ {10}/gmu, '');
    assert.doesNotThrow(() =>
      execFileSync('node', ['--check', '--input-type=module'], {
        input: source,
        stdio: 'pipe',
      }),
    );
  }

  assert.doesNotThrow(() =>
    execFileSync('bash', ['-n'], {
      input: trustedWriteScript(workflow),
      stdio: 'pipe',
    }),
  );
});

test('trusted writer pushes one pin-only commit without force', async (context) => {
  const workflow = await readFile(reusablePath, 'utf8');
  const result = await runTrustedWrite(context, trustedWriteScript(workflow));
  assert.ifError(result.error);
  assert.equal(result.pushed, true);
  assert.match(result.trace, /push --porcelain/u);
  assert.doesNotMatch(result.trace, /--force/u);
});

test('trusted writer rejects extra files and branch races', async (context) => {
  const script = trustedWriteScript(await readFile(reusablePath, 'utf8'));
  await context.test('extra changed path', async (subcontext) => {
    const result = await runTrustedWrite(subcontext, script, {
      changedPaths: 'lead-desk.json\nscripts/commit.mjs',
    });
    assert(result.error);
    assert.equal(result.pushed, false);
  });
  await context.test('default branch advanced', async (subcontext) => {
    const result = await runTrustedWrite(subcontext, script, {
      remoteSha: 'd'.repeat(40),
    });
    assert(result.error);
    assert.equal(result.pushed, false);
  });
});
