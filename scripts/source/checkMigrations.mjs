import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const source = resolve(import.meta.dirname, '../..');
const git = (args, options = {}) =>
  execFileSync('git', args, {
    cwd: source,
    encoding: options.encoding ?? 'utf8',
  });

export const assertAppendOnlyMigrations = (previous, current) => {
  const previousNames = [...previous.keys()].toSorted();
  const currentNames = new Set(current.keys());
  for (const name of previousNames) {
    assert(currentNames.has(name), `Migration removed: ${name}`);
    assert.deepEqual(
      current.get(name),
      previous.get(name),
      `Migration rewritten: ${name}`,
    );
  }

  const last = previousNames.at(-1);
  for (const name of current.keys()) {
    assert(
      previous.has(name) || !last || name > last,
      `New migration must sort after existing history: ${name}`,
    );
  }
};

const commitIsAvailable = (runGit, sha) => {
  try {
    runGit(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves the commit to compare migration history against.
 *
 * A force-push or amended commit leaves `github.event.before` unreachable in
 * the runner's clone, so a requested baseline that is not available falls back
 * to the strongest local one: the merge base with a default branch, then the
 * first parent of HEAD. A malformed explicit baseline is still a configuration
 * error.
 */
export const resolveMigrationBaseline = (requested, runGit) => {
  if (requested && !/^0+$/u.test(requested)) {
    assert.match(
      requested,
      /^[a-f0-9]{40}$/u,
      'Invalid migration baseline commit',
    );
    if (commitIsAvailable(runGit, requested)) {
      return requested;
    }
  }

  for (const ref of ['origin/main', 'origin/HEAD']) {
    try {
      const mergeBase = runGit(['merge-base', 'HEAD', ref]).trim();
      if (mergeBase) {
        return mergeBase;
      }
    } catch {
      // The ref may not exist in the runner's clone; try the next fallback.
    }
  }

  const ancestry = runGit(['rev-list', '--parents', '-n', '1', 'HEAD'])
    .trim()
    .split(' ');
  return ancestry.length === 1 ? null : ancestry[1];
};

const main = async () => {
  const baseline = resolveMigrationBaseline(
    process.argv[2] || process.env.MIGRATION_BASE,
    git,
  );
  if (!baseline) {
    log('No migration baseline is available; nothing to compare.');
    return;
  }

  assert.match(
    baseline,
    /^[a-f0-9]{40}$/u,
    'Invalid migration baseline commit',
  );
  git(['cat-file', '-e', `${baseline}^{commit}`]);

  const previousNames = git([
    'ls-tree',
    '-r',
    '--name-only',
    baseline,
    '--',
    'drizzle',
  ])
    .split('\n')
    .filter((name) => /^drizzle\/\d{4}_[\w-]+\.sql$/u.test(name))
    .map((name) => name.slice('drizzle/'.length));
  const previous = new Map(
    previousNames.map((name) => [
      name,
      git(['show', `${baseline}:drizzle/${name}`], { encoding: 'buffer' }),
    ]),
  );
  const currentNames = (await readdir(join(source, 'drizzle'))).filter((name) =>
    /^\d{4}_[\w-]+\.sql$/u.test(name),
  );
  const current = new Map(
    await Promise.all(
      currentNames.map(async (name) => [
        name,
        await readFile(join(source, 'drizzle', name)),
      ]),
    ),
  );
  assertAppendOnlyMigrations(previous, current);
  log(`Migration history is append-only relative to ${baseline}`);
};

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await main();
}
