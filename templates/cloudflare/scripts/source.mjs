import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const bootstrapRevision = '8c8f7cdede319c7ab1785a2917c8d0f73fa565ac';
export const sourceBuildFormat = 'lead-desk-source-build';
export const checksum = (contents) =>
  createHash('sha256').update(contents).digest('hex');

export const validateConfiguration = (value) => {
  assert(
    typeof value?.repository === 'string' &&
      /^[\w.-]+\/[\w.-]+$/u.test(value.repository),
    'repository must be a GitHub owner/repository',
  );
  assert(
    typeof value.revision === 'string' &&
      /^[a-f0-9]{40}$/u.test(value.revision),
    'revision must be a full 40-character source commit',
  );
  return value;
};

export const validateSourceManifest = (value) => {
  assert.equal(value?.schemaVersion, 1, 'Unsupported source-build manifest');
  assert.equal(value.format, sourceBuildFormat, 'Unexpected build format');
  assert(
    typeof value.commit === 'string' && /^[a-f0-9]{40}$/u.test(value.commit),
    'Invalid source commit',
  );
  assert(
    typeof value.compatibilityDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(value.compatibilityDate),
    'Missing runtime compatibility date',
  );
  assert(
    Array.isArray(value.compatibilityFlags) &&
      value.compatibilityFlags.every((flag) => typeof flag === 'string'),
    'Invalid runtime flags',
  );
  assert(
    Array.isArray(value.migrations) && value.migrations.length > 0,
    'Source build has no migration history',
  );

  const names = new Set();
  for (const migration of value.migrations) {
    assert(
      typeof migration.name === 'string' &&
        /^\d{4}_[\w-]+\.sql$/u.test(migration.name),
      'Unsafe migration filename',
    );
    assert(
      typeof migration.sha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(migration.sha256),
      'Invalid migration checksum',
    );
    assert(!names.has(migration.name), 'Duplicate migration filename');
    names.add(migration.name);
  }

  return value;
};

export const validateInstallationReceipt = (value) => {
  validateSourceManifest(value);
  validateConfiguration({
    repository: value.repository,
    revision: value.commit,
  });
  return value;
};

export const assertMigrationHistory = (previous, next) => {
  validateSourceManifest(previous);
  validateSourceManifest(next);
  const current = new Map(
    next.migrations.map((migration) => [migration.name, migration.sha256]),
  );
  for (const migration of previous.migrations) {
    assert.equal(
      current.get(migration.name),
      migration.sha256,
      `Migration removed or rewritten: ${migration.name}. Updates must preserve migration history.`,
    );
  }

  const oldNames = new Set(
    previous.migrations.map((migration) => migration.name),
  );
  const last = [...oldNames].toSorted().at(-1);
  for (const migration of next.migrations) {
    assert(
      oldNames.has(migration.name) || !last || migration.name > last,
      `New migration must sort after existing history: ${migration.name}`,
    );
  }
};

export const githubRepositoryUrl = (repository) => {
  validateConfiguration({ repository, revision: '0'.repeat(40) });
  return `https://github.com/${repository}.git`;
};
