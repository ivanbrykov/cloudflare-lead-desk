import { assertRuntimeConfig, inspect } from './installed.mjs';
import {
  assertMigrationHistory,
  checksum,
  download,
  packageName,
  resolveRelease,
  validateManifest,
} from './release.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const ownership = 'Lead Desk generated installation v1\n';
const plainTree = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(
      !entry.isSymbolicLink(),
      `Package contains a symlink: ${entry.name}`,
    );
    assert(
      entry.isFile() || entry.isDirectory(),
      `Package contains a special file: ${entry.name}`,
    );
    if (entry.isDirectory()) {
      await plainTree(join(directory, entry.name));
    }
  }
};

export const installRelease = async ({
  fetchImpl = globalThis.fetch,
  release = 'latest',
  repository,
  root: installationRoot,
  token,
}) => {
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
  await mkdir(lock); // Another updater or a crashed build requires explicit operator attention.
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
    const selected = await resolveRelease({
      fetchImpl,
      release,
      repository,
      token,
    });
    await assertRuntimeConfig(root, selected.manifest);
    if (currentInfo) {
      const previousManifest = validateManifest(
        JSON.parse(await readFile(join(current, 'installation.json'), 'utf8')),
      );
      assertMigrationHistory(previousManifest, selected.manifest);
    }

    const bytes = await download(selected.url, { fetchImpl });
    assert.equal(
      checksum(bytes),
      selected.manifest.sha256,
      'Release archive checksum mismatch',
    );
    temporary = await mkdtemp(join(generated, 'staging-'));
    await writeFile(join(temporary, 'lead-desk.tgz'), bytes);
    await writeFile(
      join(temporary, 'package.json'),
      JSON.stringify({
        dependencies: { [packageName]: 'file:./lead-desk.tgz' },
        private: true,
      }) + '\n',
    );
    // The artifact is self-contained. No network dependency resolution or install scripts.
    execFileSync(
      'pnpm',
      [
        'install',
        '--offline',
        '--ignore-workspace',
        '--ignore-scripts',
        '--prod',
        '--no-frozen-lockfile',
      ],
      { cwd: temporary, stdio: 'inherit', timeout: 120_000 },
    );
    const installed = await realpath(
      join(temporary, 'node_modules', packageName),
    );
    await plainTree(installed);
    const descriptor = JSON.parse(
      await readFile(join(installed, 'package.json'), 'utf8'),
    );
    assert.equal(descriptor.name, packageName);
    assert.equal(descriptor.version, selected.manifest.version);
    assert.equal(
      Object.keys(descriptor.dependencies ?? {}).length,
      0,
      'Release is not self-contained',
    );
    assert.equal(
      Object.keys(descriptor.optionalDependencies ?? {}).length,
      0,
      'Release has optional runtime dependencies',
    );
    assert.equal(
      descriptor.exports?.['./worker'],
      './worker.mjs',
      'Unsupported Worker entrypoint',
    );
    const packaged = validateManifest(
      JSON.parse(await readFile(join(installed, 'release.json'), 'utf8')),
      false,
    );
    const expected = Object.fromEntries(
      Object.entries(selected.manifest).filter(([key]) => key !== 'sha256'),
    );
    assert.deepEqual(
      packaged,
      expected,
      'Package metadata differs from published manifest',
    );
    const files = (await readdir(join(installed, 'migrations'))).toSorted();
    assert.deepEqual(
      files,
      selected.manifest.migrations
        .map((migration) => migration.name)
        .toSorted(),
      'Migration files differ from the manifest',
    );
    for (const migration of selected.manifest.migrations) {
      assert.equal(
        checksum(await readFile(join(installed, 'migrations', migration.name))),
        migration.sha256,
        `Migration checksum mismatch: ${migration.name}`,
      );
    }

    assert(
      (await inspect(join(installed, 'worker.mjs')))?.isFile(),
      'Package Worker is missing',
    );
    assert(
      (await inspect(join(installed, 'assets/index.html')))?.isFile(),
      'Package UI is missing',
    );
    const candidate = join(temporary, 'candidate');
    await cp(installed, candidate, { recursive: true });
    const receipt = { ...selected.manifest, repository, tag: selected.tag };
    await writeFile(
      join(candidate, 'installation.json'),
      JSON.stringify(receipt, null, 2) + '\n',
    );
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
      JSON.stringify({ sha256: receipt.sha256 }) + '\n',
    );
    log(
      `Installed Lead Desk ${receipt.version} from ${receipt.tag}; sha256=${receipt.sha256}`,
    );
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
  await installRelease({
    release: process.env.LEAD_DESK_RELEASE ?? configuration.release,
    repository: configuration.repository,
    root: process.cwd(),
    token: process.env.LEAD_DESK_GITHUB_TOKEN,
  });
}
