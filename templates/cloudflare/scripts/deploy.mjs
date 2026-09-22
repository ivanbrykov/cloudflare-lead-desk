import { checkInstallation } from './installed.mjs';
import { applyEdits, modify, parse } from 'jsonc-parser';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const databaseIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

const defaultRunWrangler = (args, { capture = false, cwd } = {}) =>
  execFileSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    timeout: 120_000,
  });

const databaseId = (database) => database?.uuid ?? database?.id;

export const ensureDatabase = async ({
  root: installationRoot,
  runWrangler = defaultRunWrangler,
}) => {
  const root = resolve(installationRoot);
  const configurationPath = join(root, 'wrangler.jsonc');
  const configurationText = await readFile(configurationPath, 'utf8');
  const errors = [];
  const configuration = parse(configurationText, errors);
  assert(
    errors.length === 0 && configuration,
    'Cannot parse installation wrangler.jsonc',
  );
  const databases = configuration.d1_databases ?? [];
  const index = databases.findIndex((entry) => entry.binding === 'DB');
  assert(index >= 0, 'Your Wrangler config must bind the database as DB');
  assert.equal(
    databases.filter((entry) => entry.binding === 'DB').length,
    1,
    'Your Wrangler config must contain exactly one DB binding',
  );
  const database = databases[index];
  assert(
    typeof database.database_name === 'string' &&
      database.database_name.length > 0,
    'DB must define database_name',
  );
  if (database.database_id) {
    assert(
      databaseIdPattern.test(database.database_id),
      'DB.database_id must be a Cloudflare D1 UUID',
    );
    return database.database_id;
  }

  const list = () => {
    const value = JSON.parse(
      runWrangler(['d1', 'list', '--json'], { capture: true, cwd: root }),
    );
    assert(
      Array.isArray(value),
      'Wrangler returned an invalid D1 database list',
    );
    return value;
  };

  let match = list().find((entry) => entry.name === database.database_name);
  if (!match) {
    try {
      runWrangler(
        [
          'd1',
          'create',
          database.database_name,
          '--binding',
          'DB',
          '--update-config',
        ],
        { cwd: root },
      );
    } catch (error) {
      match = list().find((entry) => entry.name === database.database_name);
      if (!match) {
        throw error;
      }
    }

    match ??= list().find((entry) => entry.name === database.database_name);
  }

  const id = databaseId(match);
  assert(
    typeof id === 'string' && databaseIdPattern.test(id),
    `Could not resolve D1 database ${database.database_name}`,
  );
  const updated = applyEdits(
    configurationText,
    modify(configurationText, ['d1_databases', index, 'database_id'], id, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  await writeFile(configurationPath, updated);
  log(`Using D1 database ${database.database_name} (${id})`);
  return id;
};

export const deploy = async ({
  root = process.cwd(),
  runWrangler = defaultRunWrangler,
} = {}) => {
  const manifest = await checkInstallation(root);
  await ensureDatabase({ root, runWrangler });
  runWrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], { cwd: root });
  runWrangler(['deploy'], { cwd: root });
  log(`Deployed Lead Desk source ${manifest.commit}`);
};

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await deploy();
}
