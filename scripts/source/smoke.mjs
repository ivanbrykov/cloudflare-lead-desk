import { prepareSource } from '../../templates/cloudflare/scripts/build.mjs';
import { checkInstallation } from '../../templates/cloudflare/scripts/installed.mjs';
import { checksum } from '../../templates/cloudflare/scripts/source.mjs';
import { upgradePin } from '../../templates/cloudflare/scripts/upgrade.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { log as print } from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    join(await mkdtemp(join(tmpdir(), 'lead-desk-source-')), 'run'),
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
    'The bootstrap fetch uses public GitHub; controlled upgrade revisions use a local standalone Git repository.',
    'Workflow availability after the Deploy Button and workflow-token push delivery to Cloudflare are not exercised here.',
  ],
  node: process.version,
  revisions: [],
  sourceCommit: '',
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
  }, 600_000);
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

const start = async (context, revision) => {
  const label = revision.slice(0, 12);
  serverLog = createWriteStream(join(output, 'logs', `dev-${label}.log`));
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
      `Wrangler exited early; see dev-${label}.log`,
    );
    try {
      const response = await context.request.get(`${origin}/health`, {
        timeout: 1_000,
      });
      if (response.ok()) {
        assert.equal(response.headers()['x-lead-desk-commit'], revision);
        return;
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) {
        throw error;
      }
    }

    await delay(500);
  }

  throw new Error(`Wrangler did not become healthy; see dev-${label}.log`);
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

const ui = async (context, revision) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/contacts`);
  await page.getByRole('heading', { exact: true, name: 'Contacts' }).waitFor();
  await page.getByText('Survives Upgrade', { exact: true }).first().waitFor();
  await page.screenshot({
    fullPage: true,
    path: join(output, `contacts-${revision.slice(0, 12)}.png`),
  });
  assert.deepEqual(errors, []);
  await page.close();
  pass(`source-built SPA loads authenticated contacts at ${revision}`);
};

try {
  evidence.sourceCommit = (
    await command('git', ['rev-parse', 'HEAD'], source)
  ).trim();
  const upstream = join(output, 'upstream');
  await command(
    'git',
    ['clone', '--quiet', '--no-local', source, upstream],
    output,
  );
  await command('git', ['config', 'user.name', 'Lead Desk test'], upstream);
  await command(
    'git',
    ['config', 'user.email', 'lead-desk-test@example.invalid'],
    upstream,
  );
  const firstRevision = (
    await command('git', ['rev-parse', 'HEAD'], upstream)
  ).trim();
  const migrationName = '9999_source_upgrade_probe.sql';
  await writeFile(
    join(upstream, 'drizzle', migrationName),
    'CREATE TABLE source_upgrade_probe (id TEXT PRIMARY KEY);\n',
  );
  await command('git', ['add', '--', `drizzle/${migrationName}`], upstream);
  await command(
    'git',
    ['commit', '--quiet', '-m', 'test: add upgrade probe migration'],
    upstream,
  );
  const secondRevision = (
    await command('git', ['rev-parse', 'HEAD'], upstream)
  ).trim();
  evidence.revisions.push(firstRevision, secondRevision);
  const repositoryUrl = `file://${upstream}`;

  await command('pnpm', ['install', '--frozen-lockfile']);
  await command('pnpm', ['run', 'build']);
  const bootstrapReceipt = await checkInstallation(consumer);
  assert.equal(
    bootstrapReceipt.commit,
    '8c8f7cdede319c7ab1785a2917c8d0f73fa565ac',
  );
  pass(
    'fresh consumer fetched and compiled the real reachable bootstrap commit',
  );

  const firstUpgrade = await upgradePin({
    repositoryUrl,
    root: consumer,
    targetRevision: firstRevision,
  });
  assert.equal(firstUpgrade.changed, true);
  const pinnedFirst = await readFile(join(consumer, 'lead-desk.json'), 'utf8');
  assert.equal(JSON.parse(pinnedFirst).revision, firstRevision);
  const stableFingerprints = await fingerprints();
  const unchangedReceipt = await prepareSource({
    configuration: JSON.parse(pinnedFirst),
    repositoryUrl,
    root: consumer,
  });
  assert.equal(unchangedReceipt.commit, firstRevision);
  assert.equal(
    await readFile(join(consumer, 'lead-desk.json'), 'utf8'),
    pinnedFirst,
  );
  assert.deepEqual(await fingerprints(), stableFingerprints);
  pass('ordinary rebuild remains on the exact recorded source revision');

  await migrate();
  await migrate();
  const firstMigrations = await sql(
    'SELECT name FROM d1_migrations ORDER BY name',
  );
  assert(firstMigrations.length > 0);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await start(context, firstRevision);
  assert.equal(
    (await api(context, '/lead-desk-version.json')).commit,
    firstRevision,
  );
  await api(context, '/api/auth/sign-up/email', {
    data: { email: 'owner@example.test', name: 'Source Owner', password },
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
      opportunity: { name: 'Existing deal', source: 'source-build' },
      source: 'source-build',
    },
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'source-before-upgrade',
    },
    method: 'POST',
    status: 201,
  });
  await ui(context, firstRevision);
  await stop();
  const before = await snapshot();
  await command('pnpm', ['run', 'deploy:dry-run']);

  const secondUpgrade = await upgradePin({
    repositoryUrl,
    root: consumer,
    targetRevision: secondRevision,
  });
  assert.deepEqual(secondUpgrade, {
    changed: true,
    newRevision: secondRevision,
    oldRevision: firstRevision,
  });
  const pinnedSecond = JSON.parse(
    await readFile(join(consumer, 'lead-desk.json'), 'utf8'),
  );
  assert.equal(pinnedSecond.revision, secondRevision);
  assert.deepEqual(await fingerprints(), originalFingerprints);
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
  assert(secondMigrations.some((row) => row.name === migrationName));
  await sql('SELECT * FROM source_upgrade_probe');
  await migrate();
  assert.deepEqual(
    await sql('SELECT name FROM d1_migrations ORDER BY name'),
    secondMigrations,
  );
  pass(
    'upgrade preserves CRM/account/session/token/invite rows and applies one additive migration once',
  );
  pass(
    'Worker entrypoint, resource configuration, tooling, and secrets remain byte-identical',
  );

  await start(context, secondRevision);
  assert.equal(
    (await api(context, '/lead-desk-version.json')).commit,
    secondRevision,
  );
  assert.equal(
    (await api(context, `/v1/contacts/${contact.id}`)).data.email,
    'lead@example.test',
  );
  await ui(context, secondRevision);
  pass(
    'new Worker/UI receipts are served and the existing session remains authorized',
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
      opportunity: { name: 'New deal', source: 'source-build' },
      source: 'source-build',
    },
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'source-after-upgrade',
    },
    method: 'POST',
    status: 201,
  });
  pass('existing password, invitation, and API token work after upgrade');
  await stop();
  await command('pnpm', ['run', 'deploy:dry-run']);
  pass('both controlled revisions pass consumer Wrangler deploy --dry-run');

  const installedWorker = join(consumer, '.lead-desk/current/worker.mjs');
  const previousWorkerHash = checksum(await readFile(installedWorker));
  await assert.rejects(
    prepareSource({
      configuration: { ...pinnedSecond, revision: 'f'.repeat(40) },
      repositoryUrl,
      root: consumer,
    }),
  );
  await assert.rejects(checkInstallation(consumer));
  assert.equal(checksum(await readFile(installedWorker)), previousWorkerHash);
  pass(
    'an unreachable revision invalidates readiness without replacing current output',
  );

  await command(
    'git',
    [
      'checkout',
      '--quiet',
      secondRevision,
      '--',
      'drizzle/0000_reflective_whiplash.sql',
    ],
    upstream,
  );
  await writeFile(
    join(upstream, 'drizzle', '0000_reflective_whiplash.sql'),
    `${await readFile(join(upstream, 'drizzle', '0000_reflective_whiplash.sql'), 'utf8')}\n-- forbidden rewrite\n`,
  );
  await command(
    'git',
    ['add', '--', 'drizzle/0000_reflective_whiplash.sql'],
    upstream,
  );
  await command(
    'git',
    ['commit', '--quiet', '-m', 'test: rewrite history'],
    upstream,
  );
  const rewrittenRevision = (
    await command('git', ['rev-parse', 'HEAD'], upstream)
  ).trim();
  await assert.rejects(
    prepareSource({
      configuration: { ...pinnedSecond, revision: rewrittenRevision },
      repositoryUrl,
      root: consumer,
    }),
    /Migration removed or rewritten/u,
  );
  assert.equal(checksum(await readFile(installedWorker)), previousWorkerHash);
  pass('rewritten historical SQL is rejected before replacing current output');

  const descriptorPath = join(upstream, 'package.json');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  descriptor.scripts['source:build'] = 'node -e "process.exit(23)"';
  await writeFile(
    descriptorPath,
    `${JSON.stringify(descriptor, undefined, 2)}\n`,
  );
  await command('git', ['add', '--', 'package.json'], upstream);
  await command(
    'git',
    ['commit', '--quiet', '-m', 'test: fail source build'],
    upstream,
  );
  const brokenBuildRevision = (
    await command('git', ['rev-parse', 'HEAD'], upstream)
  ).trim();
  await assert.rejects(
    prepareSource({
      configuration: { ...pinnedSecond, revision: brokenBuildRevision },
      repositoryUrl,
      root: consumer,
    }),
  );
  await assert.rejects(checkInstallation(consumer));
  assert.equal(checksum(await readFile(installedWorker)), previousWorkerHash);
  pass('a source-build failure blocks deploy and preserves current output');

  await prepareSource({
    configuration: pinnedSecond,
    repositoryUrl,
    root: consumer,
  });
  await checkInstallation(consumer);
  assert.deepEqual(await fingerprints(), originalFingerprints);
  const alreadyCurrent = await upgradePin({
    repositoryUrl,
    root: consumer,
    targetRevision: secondRevision,
  });
  assert.equal(alreadyCurrent.changed, false);
  assert.equal(
    JSON.parse(await readFile(join(consumer, 'lead-desk.json'), 'utf8'))
      .revision,
    secondRevision,
  );
  pass(
    'a successful rebuild recovers readiness and an already-current upgrade is idempotent',
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
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  print(`Evidence: ${output}`);
}
