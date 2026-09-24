import {
  checksum,
  sourceBuildFormat,
  validateSourceManifest,
} from './manifest.mjs';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import typescript from 'typescript';

const usage = 'Usage: node scripts/source/build.mjs <new-output-directory>';
const [destinationArgument] = process.argv.slice(2);

assert(destinationArgument, usage);

const source = resolve(import.meta.dirname, '../..');
const destination = resolve(destinationArgument);

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
  const destinationDirectory = join(destination, 'migrations');
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
      return { name, sha256: checksum(contents) };
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

const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: source,
  encoding: 'utf8',
}).trim();
assert.match(commit, /^[a-f0-9]{40}$/u, 'Could not resolve source commit');
assert.equal(
  execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: source,
    encoding: 'utf8',
  }),
  '',
  'Source checkout has tracked changes; refusing to stamp them as the pinned commit',
);

await mkdir(destination);
const wrangler = await readWranglerConfiguration();

execFileSync('pnpm', ['run', 'build'], { cwd: source, stdio: 'inherit' });

await build({
  bundle: true,
  // This bundle runs inside workerd after installation. Selecting browser
  // exports here would embed Better Auth's shared-slot async-storage polyfill.
  conditions: ['workerd'],
  external: ['cloudflare:*', 'node:*'],
  format: 'esm',
  legalComments: 'linked',
  outfile: join(destination, 'worker.mjs'),
  platform: 'browser',
  stdin: {
    contents: `import core from './src/worker-global.ts';
export default {
  async fetch(request, env, ctx) {
    const response = await core.fetch(request, env, ctx);
    const stamped = new Response(response.body, response);
    stamped.headers.set('X-Lead-Desk-Commit', ${JSON.stringify(commit)});
    return stamped;
  }
};`,
    resolveDir: source,
    sourcefile: 'source-build-entry.js',
  },
  target: 'es2022',
  tsconfig: join(source, 'tsconfig.json'),
});

await copyFile(join(source, 'LICENSE'), join(destination, 'LICENSE'));
await cp(join(source, 'dist'), join(destination, 'assets'), {
  recursive: true,
});
await writeJson(join(destination, 'assets', 'lead-desk-version.json'), {
  commit,
});

const migrations = (await copyMigrations()).toSorted((left, right) =>
  left.name.localeCompare(right.name),
);
const manifest = validateSourceManifest({
  commit,
  compatibilityDate: wrangler.compatibilityDate,
  compatibilityFlags: wrangler.compatibilityFlags,
  format: sourceBuildFormat,
  migrations,
  schemaVersion: 1,
});
await writeJson(join(destination, 'source.json'), manifest);

log(`Built Lead Desk source ${commit} in ${destination}`);
