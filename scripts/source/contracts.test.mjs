import { prepareSource } from '../../templates/cloudflare/scripts/build.mjs';
import {
  deploy as deployInstallation,
  ensureDatabase,
} from '../../templates/cloudflare/scripts/deploy.mjs';
import {
  assertRuntimeConfig,
  checkInstallation,
} from '../../templates/cloudflare/scripts/installed.mjs';
import {
  assertMigrationHistory,
  checksum,
  validateConfiguration,
  validateSourceManifest,
} from '../../templates/cloudflare/scripts/source.mjs';
import { upgradePin } from '../../templates/cloudflare/scripts/upgrade.mjs';
import { assertAppendOnlyMigrations } from './checkMigrations.mjs';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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

const commit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const migrationDigest = 'c'.repeat(64);
const databaseId = '11111111-1111-4111-8111-111111111111';
const root = resolve(import.meta.dirname, '../..');
const workflowPath = join(
  root,
  'templates/cloudflare/.github/workflows/upgrade.yml',
);

const manifest = (overrides = {}) => ({
  commit,
  compatibilityDate: '2026-08-23',
  compatibilityFlags: ['nodejs_compat'],
  format: 'lead-desk-source-build',
  migrations: [{ name: '0001_initial.sql', sha256: migrationDigest }],
  schemaVersion: 1,
  ...overrides,
});

const installationFixture = async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-desk-installation-'));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const generated = join(directory, '.lead-desk');
  const current = join(generated, 'current');
  await mkdir(current, { recursive: true });
  await writeFile(
    join(directory, 'wrangler.jsonc'),
    JSON.stringify({
      assets: { binding: 'ASSETS', directory: '.lead-desk/current/assets' },
      compatibility_date: '2026-08-23',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        {
          binding: 'DB',
          database_id: databaseId,
          database_name: 'my-lead-desk',
          migrations_dir: '.lead-desk/current/migrations',
        },
      ],
    }),
  );
  const configuration = {
    repository: 'ivanbrykov/cloudflare-lead-desk',
    revision: commit,
  };
  await writeFile(
    join(directory, 'lead-desk.json'),
    `${JSON.stringify(configuration)}\n`,
  );
  await writeFile(
    join(generated, '.owned'),
    'Lead Desk generated source installation v1\n',
  );
  await writeFile(join(current, 'worker.mjs'), 'export default {};\n');
  const receipt = { ...manifest(), repository: configuration.repository };
  const receiptBytes = `${JSON.stringify(receipt)}\n`;
  await writeFile(join(current, 'installation.json'), receiptBytes);
  await writeFile(
    join(generated, 'ready.json'),
    `${JSON.stringify({ receiptSha256: checksum(receiptBytes) })}\n`,
  );
  return { configuration, directory, generated, receipt };
};

const databaseFixture = async (context, database = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-desk-database-'));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const path = join(directory, 'wrangler.jsonc');
  await writeFile(
    path,
    `${JSON.stringify(
      {
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'my-lead-desk',
            migrations_dir: '.lead-desk/current/migrations',
            ...database,
          },
        ],
      },
      undefined,
      2,
    )}\n`,
  );
  return { directory, path };
};

const extractTrustedWriteScript = (workflow) => {
  const commitJob = workflow.indexOf('\n  commit:\n');
  assert.notEqual(commitJob, -1, 'Workflow has no commit job');
  const marker = '        run: |\n';
  const start = workflow.indexOf(marker, commitJob);
  assert.notEqual(start, -1, 'Commit job has no inline write step');
  return workflow
    .slice(start + marker.length)
    .split('\n')
    .map((line) => {
      assert(
        line === '' || line.startsWith('          '),
        'Unexpected content after trusted write block',
      );
      return line.slice(10);
    })
    .join('\n');
};

const runTrustedWrite = async (
  context,
  script,
  { changedPaths = 'lead-desk.json', remoteSha = commit } = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-desk-write-job-'));
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
      repository: 'upstream/source',
      revision: nextCommit,
    })}\n`,
  );
  const scriptPath = join(directory, 'trusted-write.sh');
  const summaryPath = join(directory, 'summary.md');
  const tracePath = join(directory, 'git.log');
  const pushMarker = join(directory, 'pushed');
  await writeFile(scriptPath, script);
  const environment = {
    ...process.env,
    BASE_SHA: commit,
    DEFAULT_BRANCH: 'trunk',
    GITHUB_STEP_SUMMARY: summaryPath,
    INSTALLATION_REPOSITORY: 'customer/installation',
    MOCK_CHANGED_PATHS: changedPaths,
    MOCK_GIT_TRACE: tracePath,
    MOCK_ORIGINAL_CONFIG: originalConfig,
    MOCK_PUSH_MARKER: pushMarker,
    MOCK_REMOTE_SHA: remoteSha,
    OLD_REPOSITORY: 'upstream/source',
    OLD_REVISION: nextCommit,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    REPOSITORY_WRITE_TOKEN: 'fake-write-credential',
    RUNNER_TEMP: directory,
    TARGET_REVISION: 'c'.repeat(40),
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

test('source configuration requires an exact immutable revision', () => {
  assert.deepEqual(
    validateConfiguration({
      repository: 'ivanbrykov/cloudflare-lead-desk',
      revision: commit,
    }),
    { repository: 'ivanbrykov/cloudflare-lead-desk', revision: commit },
  );
  assert.throws(
    () =>
      validateConfiguration({
        repository: 'ivanbrykov/cloudflare-lead-desk',
        revision: 'main',
      }),
    /full 40-character source commit/u,
  );
});

test('source manifest validates runtime and migration receipts', () => {
  assert.doesNotThrow(() => validateSourceManifest(manifest()));
  assert.throws(
    () => validateSourceManifest(manifest({ format: 'release-archive' })),
    /Unexpected build format/u,
  );
  assert.throws(
    () =>
      validateSourceManifest(
        manifest({
          migrations: [
            { name: '../0001_initial.sql', sha256: migrationDigest },
          ],
        }),
      ),
    /Unsafe migration filename/u,
  );
});

test('migration history permits append-only changes and rejects rewrites', () => {
  const appended = manifest({
    commit: nextCommit,
    migrations: [
      ...manifest().migrations,
      { name: '0002_add_pipeline.sql', sha256: 'd'.repeat(64) },
    ],
  });
  assert.doesNotThrow(() => assertMigrationHistory(manifest(), appended));
  assert.throws(
    () =>
      assertMigrationHistory(
        manifest(),
        manifest({
          commit: nextCommit,
          migrations: [{ name: '0001_initial.sql', sha256: 'd'.repeat(64) }],
        }),
      ),
    /removed or rewritten/u,
  );
  assert.throws(
    () =>
      assertAppendOnlyMigrations(
        new Map([['0001_initial.sql', Buffer.from('old')]]),
        new Map([['0001_initial.sql', Buffer.from('new')]]),
      ),
    /rewritten/u,
  );
});

test('runtime validation refuses incompatible source requirements', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-desk-runtime-'));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const configuration = {
    assets: { binding: 'ASSETS', directory: '.lead-desk/current/assets' },
    compatibility_date: '2026-08-22',
    compatibility_flags: [],
    d1_databases: [
      { binding: 'DB', migrations_dir: '.lead-desk/current/migrations' },
    ],
  };
  await writeFile(
    join(directory, 'wrangler.jsonc'),
    JSON.stringify(configuration),
  );
  await assert.rejects(
    assertRuntimeConfig(directory, manifest()),
    /compatibility_date/u,
  );
  await writeFile(
    join(directory, 'wrangler.jsonc'),
    JSON.stringify({
      ...configuration,
      compatibility_date: '2026-08-23',
    }),
  );
  await assert.rejects(
    assertRuntimeConfig(directory, manifest()),
    /compatibility_flags/u,
  );
});

test('deploy preflight binds prepared output to the tracked source pin', async (context) => {
  await context.test('exact receipt passes', async (subcontext) => {
    const fixture = await installationFixture(subcontext);
    assert.equal((await checkInstallation(fixture.directory)).commit, commit);
  });

  await context.test('changed pin rejects old output', async (subcontext) => {
    const fixture = await installationFixture(subcontext);
    await writeFile(
      join(fixture.directory, 'lead-desk.json'),
      `${JSON.stringify({
        ...fixture.configuration,
        revision: nextCommit,
      })}\n`,
    );
    await assert.rejects(
      checkInstallation(fixture.directory),
      /Prepared source revision does not match/iu,
    );
  });

  await context.test(
    'stale repository receipt is rejected',
    async (subcontext) => {
      const fixture = await installationFixture(subcontext);
      const staleReceiptBytes = `${JSON.stringify({
        ...fixture.receipt,
        repository: 'other/project',
      })}\n`;
      await writeFile(
        join(fixture.generated, 'current/installation.json'),
        staleReceiptBytes,
      );
      await writeFile(
        join(fixture.generated, 'ready.json'),
        `${JSON.stringify({
          receiptSha256: checksum(staleReceiptBytes),
        })}\n`,
      );
      await assert.rejects(
        checkInstallation(fixture.directory),
        /Prepared source repository does not match/iu,
      );
    },
  );

  await context.test(
    'malformed tracked configuration is rejected',
    async (subcontext) => {
      const fixture = await installationFixture(subcontext);
      await writeFile(join(fixture.directory, 'lead-desk.json'), '{');
      await assert.rejects(checkInstallation(fixture.directory), SyntaxError);
    },
  );
});

test('failed configuration validation invalidates deploy readiness', async (context) => {
  await context.test(
    'semantically invalid configuration',
    async (subcontext) => {
      const fixture = await installationFixture(subcontext);
      await assert.rejects(
        prepareSource({
          configuration: {
            repository: fixture.configuration.repository,
            revision: 'main',
          },
          root: fixture.directory,
        }),
        /full 40-character source commit/u,
      );
      await assert.rejects(readFile(join(fixture.generated, 'ready.json')), {
        code: 'ENOENT',
      });
    },
  );

  await context.test('malformed tracked JSON', async (subcontext) => {
    const fixture = await installationFixture(subcontext);
    await writeFile(join(fixture.directory, 'lead-desk.json'), '{');
    await assert.rejects(
      prepareSource({ root: fixture.directory }),
      SyntaxError,
    );
    await assert.rejects(readFile(join(fixture.generated, 'ready.json')), {
      code: 'ENOENT',
    });
  });
});

test('already-current upgrade does not rewrite the pin', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lead-desk-upgrade-'));
  context.after(async () => rm(directory, { force: true, recursive: true }));
  const configuration = {
    repository: 'ivanbrykov/cloudflare-lead-desk',
    revision: commit,
  };
  const path = join(directory, 'lead-desk.json');
  await writeFile(path, `${JSON.stringify(configuration, undefined, 2)}\n`);
  assert.deepEqual(
    await upgradePin({ root: directory, targetRevision: commit }),
    { changed: false, newRevision: commit, oldRevision: commit },
  );
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), configuration);
});

test('dedicated template workflow and README are repository-relative', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const readme = await readFile(
    join(root, 'templates/cloudflare/README.md'),
    'utf8',
  );
  assert.match(workflow, /permissions:\n {2}contents: read/u);
  assert.equal(workflow.match(/contents: write/gu)?.length, 1);
  assert.equal(workflow.match(/persist-credentials: false/gu)?.length, 2);
  assert.equal(workflow.match(/actions\/checkout@[a-f0-9]{40}/gu)?.length, 2);
  assert.equal(workflow.match(/actions\/setup-node@[a-f0-9]{40}/gu)?.length, 2);
  assert.equal(workflow.match(/pnpm\/action-setup@[a-f0-9]{40}/gu)?.length, 1);
  assert.doesNotMatch(workflow, /uses: [^\n]+@v\d/u);
  assert.match(
    workflow,
    /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4/u,
  );
  assert.match(
    workflow,
    /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4/u,
  );
  assert.match(
    workflow,
    /pnpm\/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4/u,
  );
  assert.match(workflow, /git fetch --no-auto-maintenance/u);
  assert.match(workflow, /GIT_CONFIG_KEY_4=maintenance\.auto/u);
  assert.match(workflow, /GIT_CONFIG_KEY_5=gc\.auto/u);
  assert.match(workflow, /github\.event\.repository\.default_branch/u);
  assert.doesNotMatch(workflow, /cloudflare.*token/iu);
  assert.match(readme, /\.\.\/\.\.\/actions\/workflows\/upgrade\.yml/u);
  assert.doesNotMatch(
    readme,
    /github\.com\/ivanbrykov\/cloudflare-lead-desk\/actions/u,
  );
  await assert.rejects(
    readFile(join(root, 'templates/cloudflare/upgrade-workflow.yml')),
    { code: 'ENOENT' },
  );
});

test('deployment resolves or creates one durable D1 binding', async (context) => {
  await context.test(
    'preserves a configured database ID',
    async (subcontext) => {
      const fixture = await databaseFixture(subcontext, {
        database_id: databaseId,
      });
      const calls = [];
      assert.equal(
        await ensureDatabase({
          root: fixture.directory,
          runWrangler: (...args) => calls.push(args),
        }),
        databaseId,
      );
      assert.deepEqual(calls, []);
    },
  );

  await context.test(
    'resolves an existing database by name',
    async (subcontext) => {
      const fixture = await databaseFixture(subcontext);
      const calls = [];
      assert.equal(
        await ensureDatabase({
          root: fixture.directory,
          runWrangler: (args) => {
            calls.push(args);
            return JSON.stringify([{ name: 'my-lead-desk', uuid: databaseId }]);
          },
        }),
        databaseId,
      );
      assert.deepEqual(calls, [['d1', 'list', '--json']]);
      assert.equal(
        JSON.parse(await readFile(fixture.path, 'utf8')).d1_databases[0]
          .database_id,
        databaseId,
      );
    },
  );

  await context.test(
    'creates a missing database before migrations',
    async (subcontext) => {
      const fixture = await databaseFixture(subcontext);
      const calls = [];
      let listed = false;
      assert.equal(
        await ensureDatabase({
          root: fixture.directory,
          runWrangler: (args) => {
            calls.push(args);
            if (args[1] === 'list') {
              if (listed) {
                return JSON.stringify([
                  { name: 'my-lead-desk', uuid: databaseId },
                ]);
              }

              listed = true;
              return '[]';
            }

            return undefined;
          },
        }),
        databaseId,
      );
      assert.deepEqual(calls, [
        ['d1', 'list', '--json'],
        ['d1', 'create', 'my-lead-desk', '--binding', 'DB', '--update-config'],
        ['d1', 'list', '--json'],
      ]);
    },
  );
});

test('deployment applies migrations before activating the Worker', async (context) => {
  const fixture = await installationFixture(context);
  const calls = [];
  await deployInstallation({
    root: fixture.directory,
    runWrangler: (args) => calls.push(args),
  });
  assert.deepEqual(calls, [
    ['d1', 'migrations', 'apply', 'DB', '--remote'],
    ['deploy'],
  ]);
});

test('ephemeral source fetches disable detached Git maintenance', async () => {
  const builder = await readFile(
    join(root, 'templates/cloudflare/scripts/build.mjs'),
    'utf8',
  );
  assert.match(builder, /'--no-auto-maintenance'/u);
  assert.match(builder, /\['config', 'maintenance\.auto', 'false'\]/u);
  assert.match(builder, /\['config', 'gc\.auto', '0'\]/u);
});

test('candidate validation is isolated from repository write authority', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const commitJob = workflow.indexOf('\n  commit:\n');
  const beforeCommit = workflow.slice(0, commitJob);
  const writeJob = workflow.slice(commitJob);
  assert.doesNotMatch(beforeCommit, /contents: write/u);
  assert.doesNotMatch(beforeCommit, /github\.token/u);
  assert.doesNotMatch(
    beforeCommit,
    /upload-artifact|download-artifact|cache/iu,
  );
  assert.doesNotMatch(writeJob, /uses:|node scripts\/|pnpm /u);
  assert.doesNotMatch(writeJob, /commitUpgrade\.mjs/u);
  assert.match(writeJob, /REPOSITORY_WRITE_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(writeJob, /changed_paths.*lead-desk\.json/su);
  assert.match(writeJob, /remote_head.*BASE_SHA/su);
});

test('trusted write step pushes only one reconstructed pin change', async (context) => {
  const workflow = await readFile(workflowPath, 'utf8');
  const script = extractTrustedWriteScript(workflow);
  assert.doesNotThrow(() =>
    execFileSync('bash', ['-n'], { input: script, stdio: 'pipe' }),
  );
  const result = await runTrustedWrite(context, script);
  assert.ifError(result.error);
  assert.equal(result.pushed, true);
  assert.match(result.trace, /push --porcelain/u);
  assert.doesNotMatch(result.trace, /--force/u);
});

test('trusted write step rejects candidate tampering and a changed base', async (context) => {
  await context.test('unexpected changed path', async (subcontext) => {
    const workflow = await readFile(workflowPath, 'utf8');
    const result = await runTrustedWrite(
      subcontext,
      extractTrustedWriteScript(workflow),
      { changedPaths: 'lead-desk.json\nscripts/commitUpgrade.mjs' },
    );
    assert(result.error);
    assert.equal(result.pushed, false);
  });

  await context.test('default branch advanced', async (subcontext) => {
    const workflow = await readFile(workflowPath, 'utf8');
    const result = await runTrustedWrite(
      subcontext,
      extractTrustedWriteScript(workflow),
      { remoteSha: 'd'.repeat(40) },
    );
    assert(result.error);
    assert.equal(result.pushed, false);
  });
});
