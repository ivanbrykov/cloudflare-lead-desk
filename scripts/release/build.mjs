import { versionPattern } from '../../templates/cloudflare/scripts/release.mjs';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { createHash } from 'node:crypto';
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import typescript from 'typescript';

const usage =
  'Usage: node scripts/release/build.mjs <new-output-directory> <version>';
const [destinationArgument, version] = process.argv.slice(2);

assert(destinationArgument, usage);
assert(version, usage);
assert(
  versionPattern.test(version),
  `Version must be a valid semver version: ${version}`,
);

const source = resolve(import.meta.dirname, '../..');
const destination = resolve(destinationArgument);
const packageDirectory = join(destination, 'package');

const sha256 = (contents) =>
  createHash('sha256').update(contents).digest('hex');

const readWranglerConfiguration = async () => {
  const configurationPath = join(source, 'wrangler.jsonc');
  const parsed = typescript.parseConfigFileTextToJson(
    configurationPath,
    await readFile(configurationPath, 'utf8'),
  );

  assert(!parsed.error, `Could not parse ${configurationPath}`);
  assert(
    typeof parsed.config.compatibility_date === 'string',
    'wrangler.jsonc must define compatibility_date',
  );
  assert(
    Array.isArray(parsed.config.compatibility_flags) &&
      parsed.config.compatibility_flags.every(
        (flag) => typeof flag === 'string',
      ),
    'wrangler.jsonc must define compatibility_flags as an array of strings',
  );

  return {
    compatibilityDate: parsed.config.compatibility_date,
    compatibilityFlags: parsed.config.compatibility_flags,
  };
};

const copyMigrations = async () => {
  const sourceDirectory = join(source, 'drizzle');
  const destinationDirectory = join(packageDirectory, 'migrations');
  await mkdir(destinationDirectory);

  const names = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith('.sql'))
    .toSorted();

  return Promise.all(
    names.map(async (name) => {
      const contents = await readFile(join(sourceDirectory, name));
      await copyFile(
        join(sourceDirectory, name),
        join(destinationDirectory, name),
      );
      return { name, sha256: sha256(contents) };
    }),
  );
};

const writeJson = async (path, value) =>
  writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);

try {
  await stat(destination);
  assert.fail(`Output directory already exists: ${destination}`);
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}

await mkdir(destination);
await mkdir(packageDirectory);

const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: source,
  encoding: 'utf8',
}).trim();
const wrangler = await readWranglerConfiguration();

execFileSync('pnpm', ['run', 'build'], { cwd: source, stdio: 'inherit' });

await build({
  bundle: true,
  external: ['cloudflare:*', 'node:*'],
  format: 'esm',
  legalComments: 'linked',
  outfile: join(packageDirectory, 'worker.mjs'),
  platform: 'browser',
  stdin: {
    contents: `import core from './src/worker-global.ts';
export default {
  async fetch(request, env, ctx) {
    const response = await core.fetch(request, env, ctx);
    const stamped = new Response(response.body, response);
    stamped.headers.set('X-Lead-Desk-Version', ${JSON.stringify(version)});
    stamped.headers.set('X-Lead-Desk-Commit', ${JSON.stringify(commit)});
    return stamped;
  }
};`,
    resolveDir: source,
    sourcefile: 'release-entry.js',
  },
  target: 'es2022',
  tsconfig: join(source, 'tsconfig.json'),
});

await copyFile(join(source, 'LICENSE'), join(packageDirectory, 'LICENSE'));
await cp(join(source, 'dist'), join(packageDirectory, 'assets'), {
  recursive: true,
});

await writeJson(join(packageDirectory, 'assets', 'lead-desk-version.json'), {
  commit,
  version,
});

const migrations = (await copyMigrations()).toSorted((left, right) =>
  left.name.localeCompare(right.name),
);
const releaseMetadata = {
  asset: 'lead-desk.tgz',
  commit,
  compatibilityDate: wrangler.compatibilityDate,
  compatibilityFlags: wrangler.compatibilityFlags,
  migrations,
  packageName: '@ivanbrykov/lead-desk',
  schemaVersion: 1,
  version,
};

await writeJson(join(packageDirectory, 'release.json'), releaseMetadata);

const legalCommentFiles = (await readdir(packageDirectory))
  .filter((name) => name.endsWith('.LEGAL.txt'))
  .toSorted();
await writeJson(join(packageDirectory, 'package.json'), {
  exports: { './worker': './worker.mjs' },
  files: [
    'worker.mjs',
    ...legalCommentFiles,
    'assets',
    'migrations',
    'release.json',
    'LICENSE',
  ],
  license: 'Apache-2.0',
  name: '@ivanbrykov/lead-desk',
  private: false,
  type: 'module',
  version,
});

execFileSync('pnpm', ['pack', '--pack-destination', destination], {
  cwd: packageDirectory,
  stdio: 'inherit',
});

const archiveNames = (await readdir(destination))
  .filter((name) => name.endsWith('.tgz'))
  .toSorted();
assert.equal(
  archiveNames.length,
  1,
  'pnpm pack did not produce exactly one archive',
);
const archivePath = join(destination, 'lead-desk.tgz');
await rename(join(destination, archiveNames[0]), archivePath);

await writeJson(join(destination, 'lead-desk.json'), {
  ...releaseMetadata,
  sha256: sha256(await readFile(archivePath)),
});

log(`Built ${version} in ${destination}`);
