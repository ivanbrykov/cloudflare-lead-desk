// Integration-test helper only. Production upgrades use the central workflow.
import { prepareSource } from '../../templates/cloudflare/scripts/build.mjs';
import { validateConfiguration } from '../../templates/cloudflare/scripts/source.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const upgradePin = async ({ repositoryUrl, root, targetRevision }) => {
  const path = join(root, 'lead-desk.json');
  const configuration = validateConfiguration(
    JSON.parse(await readFile(path, 'utf8')),
  );
  assert.match(targetRevision, /^[a-f0-9]{40}$/u);
  if (configuration.revision === targetRevision) {
    return {
      changed: false,
      newRevision: targetRevision,
      oldRevision: targetRevision,
    };
  }

  const receipt = await prepareSource({
    baselineConfiguration: configuration,
    configuration: { ...configuration, revision: targetRevision },
    repositoryUrl,
    root,
  });
  assert.equal(receipt.commit, targetRevision);
  await writeFile(
    path,
    `${JSON.stringify({ ...configuration, revision: targetRevision }, undefined, 2)}\n`,
  );
  return {
    changed: true,
    newRevision: targetRevision,
    oldRevision: configuration.revision,
  };
};
