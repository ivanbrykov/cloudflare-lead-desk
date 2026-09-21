import { assertRuntimeConfig, inspect } from './installed.mjs';
import {
  assertMigrationHistory,
  bootstrapRevision,
  checksum,
  githubRepositoryUrl,
  sourceBuildFormat,
  validateConfiguration,
  validateSourceManifest,
} from './source.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const ownership = 'Lead Desk generated source installation v1\n';
const sensitiveEnvironmentName =
  /(?:^|_)(?:AUTH|CLOUDFLARE|PASSWORD|SECRET|TOKEN)(?:_|$)|^(?:CF_|GH_|WRANGLER_)/iu;

const buildEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !sensitiveEnvironmentName.test(name),
    ),
  );

const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    env: buildEnvironment(),
    stdio: 'inherit',
    timeout: 600_000,
    ...options,
  });

const plainTree = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(
      !entry.isSymbolicLink(),
      `Build output contains a symlink: ${entry.name}`,
    );
    assert(
      entry.isFile() || entry.isDirectory(),
      `Build output contains a special file: ${entry.name}`,
    );
    if (entry.isDirectory()) {
      await plainTree(join(directory, entry.name));
    }
  }
};

const legacyBootstrapBuild = async ({ candidate, checkout, temporary }) => {
  const releaseDirectory = join(temporary, 'bootstrap-release');
  run(
    'pnpm',
    [
      'run',
      'release:build',
      releaseDirectory,
      `0.1.0-bootstrap.${bootstrapRevision.slice(0, 12)}`,
    ],
    { cwd: checkout },
  );
  const packaged = join(releaseDirectory, 'package');
  const legacy = JSON.parse(
    await readFile(join(packaged, 'release.json'), 'utf8'),
  );
  assert.equal(
    legacy.commit,
    bootstrapRevision,
    'Bootstrap adapter built the wrong source commit',
  );
  await cp(packaged, candidate, {
    filter: (path) =>
      !['package.json', 'release.json'].includes(path.split('/').at(-1)),
    recursive: true,
  });
  const manifest = {
    commit: legacy.commit,
    compatibilityDate: legacy.compatibilityDate,
    compatibilityFlags: legacy.compatibilityFlags,
    format: sourceBuildFormat,
    migrations: legacy.migrations,
    schemaVersion: 1,
  };
  validateSourceManifest(manifest);
  await writeFile(
    join(candidate, 'source.json'),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
};

const validateCandidate = async ({ candidate, revision }) => {
  await plainTree(candidate);
  const manifest = validateSourceManifest(
    JSON.parse(await readFile(join(candidate, 'source.json'), 'utf8')),
  );
  assert.equal(
    manifest.commit,
    revision,
    'Build output is from the wrong commit',
  );
  const files = (await readdir(join(candidate, 'migrations'))).toSorted();
  assert.deepEqual(
    files,
    manifest.migrations.map((migration) => migration.name).toSorted(),
    'Migration files differ from the source-build manifest',
  );
  for (const migration of manifest.migrations) {
    assert.equal(
      checksum(await readFile(join(candidate, 'migrations', migration.name))),
      migration.sha256,
      `Migration checksum mismatch: ${migration.name}`,
    );
  }

  assert(
    (await inspect(join(candidate, 'worker.mjs')))?.isFile(),
    'Built Worker is missing',
  );
  assert(
    (await inspect(join(candidate, 'assets/index.html')))?.isFile(),
    'Built UI is missing',
  );
  return manifest;
};

export const prepareSource = async ({
  configuration,
  repositoryUrl,
  root: installationRoot,
}) => {
  const selected = validateConfiguration(configuration);
  const root = resolve(installationRoot);
  const generated = join(root, '.lead-desk');
  const marker = join(generated, '.owned');
  const info = await inspect(generated);
  if (info) {
    assert(
      info.isDirectory() && !info.isSymbolicLink(),
      'Refusing unsafe .lead-desk directory',
    );
    const owner = await inspect(marker);
    assert(
      owner?.isFile() &&
        !owner.isSymbolicLink() &&
        (await readFile(marker, 'utf8')) === ownership,
      'Refusing unowned .lead-desk directory',
    );
  } else {
    await mkdir(generated);
    await writeFile(marker, ownership);
  }

  const lock = join(generated, '.lock');
  await mkdir(lock);
  let temporary;
  try {
    await rm(join(generated, 'ready.json'), { force: true });
    const current = join(generated, 'current');
    const currentInfo = await inspect(current);
    assert(
      !currentInfo ||
        (currentInfo.isDirectory() && !currentInfo.isSymbolicLink()),
      'Refusing unsafe current installation',
    );

    temporary = await mkdtemp(join(generated, 'staging-'));
    const checkout = join(temporary, 'source');
    await mkdir(checkout);
    run('git', ['init', '--quiet'], { cwd: checkout });
    run(
      'git',
      [
        'remote',
        'add',
        'origin',
        repositoryUrl ?? githubRepositoryUrl(selected.repository),
      ],
      { cwd: checkout },
    );
    run(
      'git',
      [
        '-c',
        'http.https://github.com/.extraheader=',
        'fetch',
        '--quiet',
        '--depth=1',
        'origin',
        selected.revision,
      ],
      { cwd: checkout },
    );
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], {
      cwd: checkout,
    });
    const resolved = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkout,
      encoding: 'utf8',
    }).trim();
    assert.equal(
      resolved,
      selected.revision,
      'Fetched the wrong source commit',
    );

    run('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout });
    const descriptor = JSON.parse(
      await readFile(join(checkout, 'package.json'), 'utf8'),
    );
    const candidate = join(temporary, 'candidate');
    if (typeof descriptor.scripts?.['source:build'] === 'string') {
      run('pnpm', ['run', 'source:build', candidate], {
        cwd: checkout,
      });
    } else {
      assert.equal(
        selected.revision,
        bootstrapRevision,
        'Pinned source does not provide the required source:build contract',
      );
      await legacyBootstrapBuild({ candidate, checkout, temporary });
    }

    const manifest = await validateCandidate({
      candidate,
      revision: selected.revision,
    });
    await assertRuntimeConfig(root, manifest);
    if (currentInfo) {
      const previousManifest = validateSourceManifest(
        JSON.parse(await readFile(join(current, 'installation.json'), 'utf8')),
      );
      assertMigrationHistory(previousManifest, manifest);
    }

    const receipt = { ...manifest, repository: selected.repository };
    const receiptBytes = `${JSON.stringify(receipt, undefined, 2)}\n`;
    await writeFile(join(candidate, 'installation.json'), receiptBytes);
    const previous = join(temporary, 'previous');
    if (currentInfo) {
      await rename(current, previous);
    }

    try {
      await rename(candidate, current);
    } catch (error) {
      if (currentInfo) {
        await rename(previous, current);
      }

      throw error;
    }

    await writeFile(
      join(generated, 'ready.json'),
      `${JSON.stringify({ receiptSha256: checksum(receiptBytes) })}\n`,
    );
    log(`Prepared Lead Desk source ${receipt.commit}`);
    return receipt;
  } finally {
    if (temporary) {
      await rm(temporary, { force: true, recursive: true });
    }

    await rm(lock, { force: true, recursive: true });
  }
};

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const configuration = JSON.parse(
    await readFile(join(process.cwd(), 'lead-desk.json'), 'utf8'),
  );
  await prepareSource({ configuration, root: process.cwd() });
}
