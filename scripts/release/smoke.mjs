import { checkInstallation } from '../../templates/cloudflare/scripts/installed.mjs';
import { checksum } from '../../templates/cloudflare/scripts/release.mjs';
import { installRelease } from '../../templates/cloudflare/scripts/update.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { log as print } from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

// Integration experiment, not a production installer. Every D1 operation is local.
const here = import.meta.dirname;
const source = resolvePath(here, '../..');
const output = resolvePath(
  process.argv[2] ??
    join(await mkdtemp(join(tmpdir(), 'lead-desk-release-')), 'run'),
);
const consumer = join(output, 'consumer');
await mkdir(output, { recursive: false });
await mkdir(join(output, 'logs'));
await cp(join(source, 'templates/cloudflare'), consumer, {
  filter: (path) => !path.includes('node_modules'),
  recursive: true,
});
const environment = {
  ...process.env,
  CI: '1',
  WRANGLER_LOG_PATH: join(output, 'logs', 'wrangler'),
  WRANGLER_SEND_METRICS: 'false',
  XDG_CONFIG_HOME: join(output, 'config'),
};
for (const key of [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_ACCOUNT_ID',
]) {
  delete environment[key];
}

const evidence = {
  checks: [],
  consumer,
  limitations: [
    'Local workerd/D1 and Wrangler dry-run only; no Cloudflare deployment or Deploy Button test.',
    'A simulated GitHub release service serves real packaged app builds; v2 adds a synthetic additive migration.',
    'GitHub release publication and real Deploy Button provisioning are not exercised here.',
  ],
  node: process.version,
  sourceCommit: '',
  versions: [],
};
let commandNumber = 0;
const command = async (
  executable,
  args,
  cwd = consumer,
  privateOutput = false,
) => {
  const name = `${String(++commandNumber).padStart(2, '0')}-${executable.replaceAll('/', '_')}`;
  const log = createWriteStream(join(output, 'logs', `${name}.log`));
  const child = spawn(executable, args, {
    cwd,
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!privateOutput) {
      log.write(chunk);
    }
  });
  child.stderr.on('data', (chunk) => log.write(chunk));
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* Process already exited. */
    }
  }, 180_000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timer);
  await new Promise((resolve) => {
    log.end(resolve);
  });
  assert.equal(
    code,
    0,
    `${executable} ${args.join(' ')} failed; see ${name}.log`,
  );
  return stdout;
};

const freePort = async () => {
  const listener = createServer();
  await new Promise((resolve) => {
    listener.listen(0, '127.0.0.1', resolve);
  });
  const selectedPort = listener.address().port;
  await new Promise((resolve) => {
    listener.close(resolve);
  });
  return selectedPort;
};

const pass = (message) => {
  evidence.checks.push(message);
  print(`PASS ${message}`);
};

const port = await freePort();
const origin = `https://127.0.0.1:${port}`;
const setupToken = randomBytes(32).toString('hex');
const password = randomBytes(24).toString('hex');
await writeFile(
  join(consumer, '.dev.vars'),
  `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}\nSETUP_TOKEN=${setupToken}\n`,
  { mode: 0o600 },
);
const protectedPaths = [
  'wrangler.jsonc',
  'src/worker.js',
  '.dev.vars',
  'package.json',
  'pnpm-lock.yaml',
  'lead-desk.json',
];
const fingerprints = async () =>
  Object.fromEntries(
    await Promise.all(
      protectedPaths.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(consumer, path)))
          .digest('hex'),
      ]),
    ),
  );
const configPath = join(consumer, 'wrangler.jsonc');
const configuration = JSON.parse(await readFile(configPath, 'utf8'));
await writeFile(
  configPath,
  JSON.stringify(
    configuration,
    (key, value) =>
      key === 'database_id' ? '11111111-1111-4111-8111-111111111111' : value,
    2,
  ) + '\n',
);
const originalFingerprints = await fingerprints();
let server;
let serverLog;
let browser;
const api = async (
  context,
  path,
  { data, headers = {}, method = 'GET', status = 200 } = {},
) => {
  const response = await context.request.fetch(`${origin}${path}`, {
    data,
    headers: { Origin: origin, ...headers },
    method,
  });
  assert.equal(
    response.status(),
    status,
    `${method} ${path}: ${await response.text()}`,
  );
  return response.json();
};

const migrate = async () => {
  await command('pnpm', ['run', 'db:migrate:local']);
};

const sql = async (query) => {
  const sqlOutput = await command(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--local',
      '--json',
      '--command',
      query,
    ],
    consumer,
    true,
  );
  return JSON.parse(sqlOutput)[0].results;
};

const snapshot = async () => {
  const rows = {};
  // Capture complete durable business/account state without saving credential data in evidence.
  for (const table of [
    'workspaces',
    'contacts',
    'opportunities',
    'user',
    'account',
    'session',
    'api_tokens',
    'staff_invites',
  ]) {
    rows[table] = await sql(`SELECT * FROM "${table}" ORDER BY id`);
  }

  return rows;
};

const start = async (context, version) => {
  serverLog = createWriteStream(join(output, 'logs', `dev-${version}.log`));
  server = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--local-protocol',
      'https',
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: consumer,
      detached: true,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(
      server.exitCode,
      null,
      `Wrangler exited early; see dev-${version}.log`,
    );
    try {
      const response = await context.request.get(`${origin}/health`, {
        timeout: 1_000,
      });
      if (response.ok()) {
        assert.equal(response.headers()['x-lead-desk-version'], version);
        return;
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) {
        throw error;
      }
    }

    await delay(500);
  }

  throw new Error(`Wrangler did not become healthy; see dev-${version}.log`);
};

const stop = async () => {
  if (!server) {
    return;
  }

  const current = server;
  server = undefined;
  if (current.exitCode === null) {
    const exited = new Promise((resolve) => {
      current.once('exit', resolve);
    });
    try {
      process.kill(-current.pid, 'SIGTERM');
    } catch {
      /* Process already exited. */
    }

    await Promise.race([exited, delay(5_000)]);
    if (current.exitCode === null) {
      try {
        process.kill(-current.pid, 'SIGKILL');
      } catch {
        /* Process already exited. */
      }

      await exited;
    }
  }

  await new Promise((resolve) => {
    serverLog.end(resolve);
  });
};

const ui = async (context, version) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/contacts`);
  await page.getByRole('heading', { exact: true, name: 'Contacts' }).waitFor();
  await page.getByText('Survives Upgrade', { exact: true }).first().waitFor();
  await page.screenshot({
    fullPage: true,
    path: join(output, `contacts-${version}.png`),
  });
  assert.deepEqual(errors, []);
  await page.close();
  pass(`real packaged SPA loads authenticated contacts in ${version}`);
};

try {
  evidence.sourceCommit = (
    await command('git', ['rev-parse', 'HEAD'], source)
  ).trim();
  const versions = ['0.1.0-test.1', '0.1.0-test.2'];
  const packages = [];
  for (const version of versions) {
    const destination = join(output, version);
    await command(
      'node',
      [join(here, 'build.mjs'), destination, version],
      source,
    );
    const archives = (await readdir(destination)).filter((name) =>
      name.endsWith('.tgz'),
    );
    assert.equal(archives.length, 1);
    const tarball = join(destination, archives[0]);
    const contents = await command('tar', ['-tzf', tarball], source);
    assert(
      !contents.includes('.dev.vars') &&
        !contents.includes('node_modules/') &&
        !contents.includes('/src/'),
      'package must not contain source workspace or secrets',
    );
    packages.push(tarball);
    evidence.versions.push({
      sha256: createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex'),
      version,
    });
  }

  const secondPath = join(output, versions[1]);
  const secondMetadata = JSON.parse(
    await readFile(join(secondPath, 'lead-desk.json'), 'utf8'),
  );
  const originalCommit = secondMetadata.commit;
  secondMetadata.commit = 'f'.repeat(40); // A simulated second release, never published.
  const migrationName = '9999_release_upgrade_probe.sql';
  const migrationSQL =
    'CREATE TABLE package_spike_upgrade (id TEXT PRIMARY KEY);\n';
  secondMetadata.migrations.push({
    name: migrationName,
    sha256: checksum(migrationSQL),
  });
  await writeFile(
    join(secondPath, 'package/migrations', migrationName),
    migrationSQL,
  );
  const workerPath = join(secondPath, 'package/worker.mjs');
  await writeFile(
    workerPath,
    (await readFile(workerPath, 'utf8')).replaceAll(
      originalCommit,
      secondMetadata.commit,
    ),
  );
  await writeFile(
    join(secondPath, 'package/assets/lead-desk-version.json'),
    JSON.stringify({ commit: secondMetadata.commit, version: versions[1] }),
  );
  await writeFile(
    join(secondPath, 'package/release.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(secondMetadata).filter(([key]) => key !== 'sha256'),
      ),
    ),
  );
  const repacked = join(secondPath, 'repacked');
  await mkdir(repacked);
  await command(
    'pnpm',
    ['pack', '--pack-destination', repacked],
    join(secondPath, 'package'),
  );
  const packedName = (await readdir(repacked)).find((name) =>
    name.endsWith('.tgz'),
  );
  await rename(join(repacked, packedName), packages[1]);
  secondMetadata.sha256 = checksum(await readFile(packages[1]));
  await writeFile(
    join(secondPath, 'lead-desk.json'),
    JSON.stringify(secondMetadata),
  );
  evidence.versions[1].sha256 = secondMetadata.sha256;
  const metadata = await Promise.all(
    versions.map(async (version) =>
      JSON.parse(
        await readFile(join(output, version, 'lead-desk.json'), 'utf8'),
      ),
    ),
  );
  let activeRelease = 0;
  let failNetwork = false;
  let corruptArchive = false;
  let rewriteHistory = false;
  const repository = 'ivanbrykov/cloudflare-lead-desk';
  const fixtureFetch = async (url) => {
    if (failNetwork) {
      return new globalThis.Response('unavailable', { status: 503 });
    }

    if (url === `https://api.github.com/repos/${repository}/releases/latest`) {
      return globalThis.Response.json({
        assets: [
          { name: 'lead-desk.tgz', state: 'uploaded' },
          { name: 'lead-desk.json', state: 'uploaded' },
        ],
        draft: false,
        prerelease: false,
        tag_name: `build-${metadata[activeRelease].commit}`,
      });
    }

    for (const [index, manifest] of metadata.entries()) {
      const base = `https://github.com/${repository}/releases/download/build-${manifest.commit}`;
      if (url === `${base}/lead-desk.json`) {
        if (rewriteHistory) {
          return globalThis.Response.json({
            ...manifest,
            migrations: manifest.migrations.map((migration, position) =>
              position === 0
                ? { ...migration, sha256: '0'.repeat(64) }
                : migration,
            ),
          });
        }

        return globalThis.Response.json(manifest);
      }

      if (url === `${base}/lead-desk.tgz`) {
        if (corruptArchive) {
          return new globalThis.Response('corrupted release archive');
        }

        return new globalThis.Response(await readFile(packages[index]));
      }
    }

    throw new Error(`Unexpected release URL: ${url}`);
  };

  pass(
    'two real packages ready; local release fixture simulates latest moving between distinct tags',
  );
  await command('pnpm', ['install', '--frozen-lockfile']);
  await installRelease({ fetchImpl: fixtureFetch, repository, root: consumer });
  await migrate();
  await migrate();
  const firstMigrations = await sql(
    'SELECT name FROM d1_migrations ORDER BY name',
  );
  assert(firstMigrations.length > 0);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await start(context, versions[0]);
  assert.equal(
    (await api(context, '/lead-desk-version.json')).version,
    versions[0],
  );
  await api(context, '/api/auth/sign-up/email', {
    data: { email: 'owner@example.test', name: 'Spike Owner', password },
    headers: { 'X-Setup-Token': setupToken },
    method: 'POST',
  });
  const contact = (
    await api(context, '/v1/contacts', {
      data: {
        email: 'lead@example.test',
        firstName: 'Survives',
        lastName: 'Upgrade',
      },
      method: 'POST',
      status: 201,
    })
  ).data;
  const token = (
    await api(context, '/v1/tokens', {
      data: { name: 'Survives upgrade' },
      method: 'POST',
      status: 201,
    })
  ).data;
  const invite = (
    await api(context, '/v1/invites', {
      data: { name: 'Survives upgrade' },
      method: 'POST',
      status: 201,
    })
  ).data;
  await api(context, '/v1/intakes', {
    data: {
      contact: { email: 'intake@example.test' },
      opportunity: { name: 'Existing deal', source: 'package-spike' },
      source: 'package-spike',
    },
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'spike-before-upgrade',
    },
    method: 'POST',
    status: 201,
  });
  await ui(context, versions[0]);
  await stop();
  const before = await snapshot();
  await command('pnpm', ['run', 'deploy:dry-run']);
  activeRelease = 1;
  await installRelease({ fetchImpl: fixtureFetch, repository, root: consumer });
  await migrate();
  const after = await snapshot();
  assert.deepEqual(
    after,
    before,
    'all existing database rows must survive unchanged before v2 receives requests',
  );
  const secondMigrations = await sql(
    'SELECT name FROM d1_migrations ORDER BY name',
  );
  assert.equal(secondMigrations.length, firstMigrations.length + 1);
  assert(
    secondMigrations.some(
      (row) => row.name === '9999_release_upgrade_probe.sql',
    ),
  );
  await sql('SELECT * FROM package_spike_upgrade');
  await migrate();
  assert.deepEqual(
    await sql('SELECT name FROM d1_migrations ORDER BY name'),
    secondMigrations,
  );
  pass(
    'upgrade preserves all existing CRM/account/session/token/invite rows and applies exactly one new migration once',
  );
  assert.deepEqual(await fingerprints(), originalFingerprints);
  pass(
    'consumer Worker entrypoint, resource configuration, and local secrets remain byte-identical',
  );
  await start(context, versions[1]);
  assert.equal(
    (await api(context, '/lead-desk-version.json')).version,
    versions[1],
  );
  assert.equal(
    (await api(context, `/v1/contacts/${contact.id}`)).data.email,
    'lead@example.test',
  );
  await ui(context, versions[1]);
  pass(
    'v2 Worker and asset markers are served; pre-upgrade session remains authorized',
  );
  const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
  await api(fresh, '/api/auth/sign-in/email', {
    data: { email: 'owner@example.test', password },
    method: 'POST',
  });
  await api(fresh, '/v1/contacts');
  const invited = await browser.newContext({ ignoreHTTPSErrors: true });
  await api(invited, '/api/auth/sign-up/email', {
    data: {
      email: 'invited@example.test',
      name: 'Invited after upgrade',
      password,
    },
    headers: { 'X-Setup-Token': invite.token },
    method: 'POST',
  });
  await api(fresh, '/v1/intakes', {
    data: {
      contact: { email: 'after@example.test' },
      opportunity: { name: 'New deal', source: 'package-spike' },
      source: 'package-spike',
    },
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'spike-after-upgrade',
    },
    method: 'POST',
    status: 201,
  });
  pass(
    'existing password, unredeemed invitation, and bearer token work after upgrade',
  );
  await stop();
  await command('pnpm', ['run', 'deploy:dry-run']);
  pass('both versions bundle with consumer Wrangler deploy --dry-run');
  failNetwork = true;
  await assert.rejects(
    installRelease({ fetchImpl: fixtureFetch, repository, root: consumer }),
    /HTTP 503/u,
  );
  await assert.rejects(checkInstallation(consumer));
  failNetwork = false;
  const installedWorker = join(consumer, '.lead-desk/current/worker.mjs');
  const previousWorkerHash = checksum(await readFile(installedWorker));
  corruptArchive = true;
  await assert.rejects(
    installRelease({ fetchImpl: fixtureFetch, repository, root: consumer }),
    /checksum mismatch/u,
  );
  await assert.rejects(checkInstallation(consumer));
  assert.equal(checksum(await readFile(installedWorker)), previousWorkerHash);
  corruptArchive = false;
  rewriteHistory = true;
  await assert.rejects(
    installRelease({ fetchImpl: fixtureFetch, repository, root: consumer }),
    /Migration removed or rewritten/u,
  );
  assert.equal(checksum(await readFile(installedWorker)), previousWorkerHash);
  rewriteHistory = false;
  pass(
    'corrupt archives and rewritten migration history are rejected before replacing the installation',
  );
  await installRelease({ fetchImpl: fixtureFetch, repository, root: consumer });
  await checkInstallation(consumer);
  assert.deepEqual(await fingerprints(), originalFingerprints);
  pass(
    'failed latest lookup blocks deploy preflight; successful rebuild recovers without tracked file changes',
  );
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error.message;
  throw error;
} finally {
  await stop();
  if (browser) {
    await browser.close();
  }

  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  print(`Evidence: ${output}`);
}
