import { checkInstallation } from './installed.mjs';
import { log } from 'node:console';
import process from 'node:process';

const manifest = await checkInstallation(process.cwd());
log(`Deploying Lead Desk source ${manifest.commit}`);
