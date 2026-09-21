import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { resolve } from 'node:path';
import process from 'node:process';

const defaultRun = (args, options) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  });

export const commitUpgrade = ({ defaultBranch, root, run = defaultRun }) => {
  assert(
    typeof defaultBranch === 'string' && /^[\w./-]+$/u.test(defaultBranch),
    'Invalid default branch',
  );
  const options = { cwd: resolve(root) };
  const changed = run(['diff', '--name-only', '--'], options)
    .trim()
    .split('\n')
    .filter(Boolean);
  if (changed.length === 0) {
    log('Source pin is already current; no commit created.');
    return false;
  }

  assert.deepEqual(
    changed,
    ['lead-desk.json'],
    'Upgrade changed files other than lead-desk.json',
  );
  run(['add', '--', 'lead-desk.json'], options);
  const staged = run(['diff', '--cached', '--name-only', '--'], options)
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(
    staged,
    ['lead-desk.json'],
    'Upgrade staged files other than lead-desk.json',
  );
  run(
    [
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '-m',
      'chore: upgrade Lead Desk source',
    ],
    options,
  );
  run(['push', 'origin', `HEAD:refs/heads/${defaultBranch}`], options);
  return true;
};

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert(process.env.LEAD_DESK_DEFAULT_BRANCH, 'Missing default branch');
  commitUpgrade({
    defaultBranch: process.env.LEAD_DESK_DEFAULT_BRANCH,
    root: process.cwd(),
  });
}
