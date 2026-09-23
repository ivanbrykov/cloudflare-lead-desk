import { installationToken } from './github.mjs';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import process from 'node:process';

assert.equal(process.env.GITHUB_REPOSITORY, 'ivanbrykov/cloudflare-lead-desk');
const token = await installationToken({
  appId: process.env.LEAD_DESK_APP_ID,
  permission: process.env.TARGET_PERMISSION,
  privateKey: process.env.LEAD_DESK_APP_PRIVATE_KEY,
  repository: process.env.TARGET_REPOSITORY,
  repositoryId: Number(process.env.TARGET_REPOSITORY_ID),
});
process.stdout.write(`::add-mask::${token}\n`);
await appendFile(process.env.GITHUB_OUTPUT, `token=${token}\n`);
