import { prepareSource } from '../../templates/cloudflare/scripts/build.mjs';
import { validateConfiguration } from '../../templates/cloudflare/scripts/source.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(process.cwd(), 'consumer');
const expected = {
  repository: 'ivanbrykov/cloudflare-lead-desk',
  revision: process.env.OLD_REVISION,
};
assert.deepEqual(
  validateConfiguration(
    JSON.parse(await readFile(resolve(root, 'lead-desk.json'), 'utf8')),
  ),
  expected,
  'Installation pin changed after resolution',
);
assert.equal(
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  process.env.BASE_SHA,
  'Installation checkout changed after resolution',
);
if (process.env.OLD_REVISION !== process.env.TARGET_REVISION) {
  const receipt = await prepareSource({
    baselineConfiguration: expected,
    configuration: { ...expected, revision: process.env.TARGET_REVISION },
    root,
  });
  assert.equal(receipt.commit, process.env.TARGET_REVISION);
}
