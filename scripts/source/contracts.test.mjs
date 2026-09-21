import { prepareSource } from '../../templates/cloudflare/scripts/build.mjs';
import { commitUpgrade } from '../../templates/cloudflare/scripts/commitUpgrade.mjs';
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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const commit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const migrationDigest = 'c'.repeat(64);
const root = resolve(import.meta.dirname, '../..');

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
        { binding: 'DB', migrations_dir: '.lead-desk/current/migrations' },
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

test('upgrade commit stages only the pin and pushes without force', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'diff' && args.includes('--cached')) {
      return 'lead-desk.json\n';
    }

    if (args[0] === 'diff') {
      return 'lead-desk.json\n';
    }

    return '';
  };

  assert.equal(
    commitUpgrade({ defaultBranch: 'trunk', root: '/tmp', run }),
    true,
  );
  assert.deepEqual(calls.at(-1), ['push', 'origin', 'HEAD:refs/heads/trunk']);
  assert.equal(calls.flat().includes('--force'), false);
});

test('upgrade commit rejects unrelated files and surfaces push rejection', () => {
  assert.throws(
    () =>
      commitUpgrade({
        defaultBranch: 'main',
        root: '/tmp',
        run: (args) =>
          args[0] === 'diff' ? 'lead-desk.json\nwrangler.jsonc\n' : '',
      }),
    /other than lead-desk\.json/u,
  );
  assert.throws(
    () =>
      commitUpgrade({
        defaultBranch: 'main',
        root: '/tmp',
        run: (args) => {
          if (args[0] === 'diff') {
            return 'lead-desk.json\n';
          }

          if (args[0] === 'push') {
            throw new Error('non-fast-forward');
          }

          return '';
        },
      }),
    /non-fast-forward/u,
  );
});

test('template workflow is reproducible and README link is repository-relative', async () => {
  const workflow = await readFile(
    join(root, 'templates/cloudflare/.github/workflows/upgrade.yml'),
    'utf8',
  );
  const fallback = await readFile(
    join(root, 'templates/cloudflare/upgrade-workflow.yml'),
    'utf8',
  );
  const readme = await readFile(
    join(root, 'templates/cloudflare/README.md'),
    'utf8',
  );
  assert.equal(workflow, fallback);
  assert.match(workflow, /permissions:\n {2}contents: write/u);
  assert.match(workflow, /github\.event\.repository\.default_branch/u);
  assert.doesNotMatch(workflow, /cloudflare.*token/iu);
  assert.match(readme, /\.\.\/\.\.\/actions\/workflows\/upgrade\.yml/u);
  assert.doesNotMatch(
    readme,
    /github\.com\/ivanbrykov\/cloudflare-lead-desk\/actions/u,
  );
});
