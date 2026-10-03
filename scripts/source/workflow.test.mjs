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
  { changedPaths = 'leadscroll.json', remoteSha = baseSha } = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), 'leadscroll-reusable-write-'));
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
    printf '100644 blob %040d\\tleadscroll.json\\n' 2
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
      repository: 'leadscroll/leadscroll',
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
    OLD_REPOSITORY: 'leadscroll/leadscroll',
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
    /uses: leadscroll\/leadscroll\/\.github\/workflows\/cloudflare-upgrade\.yml@main/u,
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
  const button = /\[!\[Upgrade LeadScroll\]\([^)]+\)\]\(([^)]+)\)/u.exec(
    readme,
  );
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
  assert.match(workflow, /Waiting for upstream main CI/u);
  assert.match(workflow, /retry Upgrade after CI finishes/u);
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

const runResolver = async (context, { ciOutcome = 'success', revision }) => {
  const workflow = await readFile(reusablePath, 'utf8');
  const [, body] =
    /node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE/u.exec(
      workflow,
    ) ?? [];
  assert(body);
  const source = body.replaceAll(/^ {10}/gmu, '');
  const directory = await mkdtemp(join(tmpdir(), 'leadscroll-resolver-'));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  await writeFile(
    join(directory, 'leadscroll.json'),
    `${JSON.stringify({
      repository: 'leadscroll/leadscroll',
      revision,
    })}\n`,
  );
  const binaryDirectory = join(directory, 'bin');
  await mkdir(binaryDirectory);
  const fakeGit = join(binaryDirectory, 'git');
  await writeFile(
    fakeGit,
    `#!/usr/bin/env bash
case "$*" in
  *'check-ref-format --branch main'*) exit 0 ;;
  *'rev-parse HEAD'*) printf '%s\\n' "$BASE_SHA" ;;
  *'ls-remote'*) printf '%s\\trefs/heads/main\\n' '${targetRevision}' ;;
  *) exit 97 ;;
esac
`,
  );
  await chmod(fakeGit, 0o755);
  const tracePath = join(directory, 'fetch.log');
  const preload = join(directory, 'mock-fetch.mjs');
  await writeFile(
    preload,
    `import { appendFileSync } from 'node:fs';
let checks = 0;
globalThis.fetch = async (url) => {
  if (url.includes('/compare/')) {
    appendFileSync(process.env.MOCK_FETCH_TRACE, 'compare\\n');
    return { status: 200, json: async () => ({
      status: 'ahead', merge_base_commit: { sha: process.env.OLD_REVISION },
    }) };
  }
  if (url.includes('/actions/workflows/ci.yml/runs')) {
    appendFileSync(process.env.MOCK_FETCH_TRACE, 'ci\\n');
    checks += 1;
    const done = process.env.MOCK_CI_OUTCOME === 'failure' || checks > 1;
    return { status: 200, json: async () => ({ workflow_runs: [{
      head_sha: process.env.TARGET_REVISION,
      head_branch: 'main',
      event: 'push',
      status: done ? 'completed' : 'in_progress',
      conclusion: done ? (process.env.MOCK_CI_OUTCOME === 'failure' ? 'failure' : 'success') : null,
    }] }) };
  }
  throw new Error('Unexpected API request');
};
globalThis.setTimeout = (callback) => { callback(); return 0; };
`,
  );
  const outputPath = join(directory, 'output');
  const environment = {
    ...process.env,
    BASE_SHA: baseSha,
    DEFAULT_BRANCH: 'main',
    GITHUB_OUTPUT: outputPath,
    GITHUB_READ_TOKEN: 'fake-read-token',
    GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    INSTALLATION_REPOSITORY: 'customer/installation',
    MOCK_CI_OUTCOME: ciOutcome,
    MOCK_FETCH_TRACE: tracePath,
    OLD_REVISION: revision,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    RUNNER_TEMP: directory,
    TARGET_REVISION: targetRevision,
  };
  let error;
  try {
    execFileSync('node', ['--import', preload, '--input-type=module'], {
      cwd: directory,
      env: environment,
      input: source,
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch (error_) {
    error = error_;
  }

  return {
    error,
    output: await readFile(outputPath, 'utf8').then(
      (value) => value,
      () => '',
    ),
    summary: await readFile(join(directory, 'summary'), 'utf8').then(
      (value) => value,
      () => '',
    ),
    trace: await readFile(tracePath, 'utf8').then(
      (value) => value,
      () => '',
    ),
  };
};

test('resolver waits for exact upstream CI and rejects a failed run', async (context) => {
  const success = await runResolver(context, { revision: oldRevision });
  assert.ifError(success.error);
  assert.match(
    success.output,
    new RegExp(`target_revision=${targetRevision}`, 'u'),
  );
  assert.match(success.output, /pin_change_required=true/u);
  assert.equal(success.trace, 'compare\nci\nci\n');
  const failure = await runResolver(context, {
    ciOutcome: 'failure',
    revision: oldRevision,
  });
  assert.match(
    String(failure.error),
    /Upstream main CI failed or was cancelled/u,
  );
});

test('resolver queues a pin commit for the main channel', async (context) => {
  const result = await runResolver(context, { revision: 'main' });
  assert.ifError(result.error);
  assert.match(
    result.output,
    new RegExp(`old_revision=${targetRevision}`, 'u'),
  );
  assert.match(
    result.output,
    new RegExp(`target_revision=${targetRevision}`, 'u'),
  );
  assert.match(result.output, /pin_change_required=true/u);
  assert.match(result.summary, /Pin change required: yes/u);
  assert.equal(result.trace, 'ci\nci\n');
});

test('resolver requests no pin change when the pinned sha is upstream main', async (context) => {
  const result = await runResolver(context, { revision: targetRevision });
  assert.ifError(result.error);
  assert.match(result.output, /pin_change_required=false/u);
  assert.equal(result.trace, '');
});

test('reusable upgrade gates the pin commit on a required pin change', async () => {
  const workflow = await readFile(reusablePath, 'utf8');
  assert.match(
    workflow,
    /pin_change_required: \$\{\{ steps\.resolve\.outputs\.pin_change_required \}\}/u,
  );
  const commitJob = workflow.slice(workflow.indexOf('\n  commit:\n'));
  assert.match(
    commitJob,
    /if: needs\.resolve\.outputs\.pin_change_required == 'true'/u,
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
      changedPaths: 'leadscroll.json\nscripts/commit.mjs',
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
