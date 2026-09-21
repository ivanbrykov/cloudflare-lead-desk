import {
  checksum,
  validateConfiguration,
  validateInstallationReceipt,
} from './source.mjs';
import { parse } from 'jsonc-parser';
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const inspect = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
};

export const assertRuntimeConfig = async (root, manifest) => {
  const errors = [];
  const config = parse(
    await readFile(join(root, 'wrangler.jsonc'), 'utf8'),
    errors,
  );
  assert(
    errors.length === 0 && config,
    'Cannot parse installation wrangler.jsonc',
  );
  assert(
    typeof config.compatibility_date === 'string' &&
      config.compatibility_date >= manifest.compatibilityDate,
    `This source revision requires compatibility_date >= ${manifest.compatibilityDate}; review and update your Wrangler config.`,
  );
  assert(
    manifest.compatibilityFlags.every((flag) =>
      config.compatibility_flags?.includes(flag),
    ),
    'This source revision needs additional compatibility_flags; review your Wrangler config.',
  );
  const database = config.d1_databases?.find(
    (binding) => binding.binding === 'DB',
  );
  assert(
    database,
    'Your Wrangler config must bind the existing D1 database as DB',
  );
  assert.equal(
    resolve(root, database.migrations_dir ?? ''),
    join(root, '.lead-desk/current/migrations'),
    'DB.migrations_dir must be .lead-desk/current/migrations',
  );
  assert.equal(
    config.assets?.binding,
    'ASSETS',
    'Assets must be bound as ASSETS',
  );
  assert.equal(
    resolve(root, config.assets?.directory ?? ''),
    join(root, '.lead-desk/current/assets'),
    'assets.directory must be .lead-desk/current/assets',
  );
};

export const checkInstallation = async (root) => {
  assert(
    !(await inspect(join(root, '.lead-desk/.lock'))),
    'An update is incomplete or still running; do not deploy until it finishes.',
  );
  const configuration = validateConfiguration(
    JSON.parse(await readFile(join(root, 'lead-desk.json'), 'utf8')),
  );
  const current = join(root, '.lead-desk/current');
  const receiptBytes = await readFile(join(current, 'installation.json'));
  const manifest = validateInstallationReceipt(
    JSON.parse(receiptBytes.toString()),
  );
  assert.equal(
    manifest.repository,
    configuration.repository,
    'Prepared source repository does not match lead-desk.json. Run pnpm run build successfully before deploying.',
  );
  assert.equal(
    manifest.commit,
    configuration.revision,
    'Prepared source revision does not match lead-desk.json. Run pnpm run build successfully before deploying.',
  );
  const ready = JSON.parse(
    await readFile(join(root, '.lead-desk/ready.json'), 'utf8'),
  );
  assert.equal(
    ready.receiptSha256,
    checksum(receiptBytes),
    'Installation is not ready. Run pnpm run build successfully before deploying.',
  );
  await assertRuntimeConfig(root, manifest);
  assert(
    (await inspect(join(current, 'worker.mjs')))?.isFile(),
    'Installed Worker is missing',
  );
  return manifest;
};
