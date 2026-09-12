import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';

/**
 * End-to-end checks for the structured request logging added in stage 3b.
 *
 * The worker is bundled the same way as the other D1 suites and runs in
 * Miniflare against a real local D1 database. Workerd structured logs are
 * captured with `handleStructuredLogs`; each test asserts on the exact JSON
 * lines the worker emitted for its requests.
 *
 * Covered: one JSON line per API request with method/path/status/durationMs,
 * 5xx at error level, the structured persistence-failure line (class only,
 * never the cause message or SQL), query strings and auth headers kept out
 * of the logs, and the final status on the intake 413 path.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Logging regression tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

type StructuredLog = {
  level: string;
  message: string;
};

let workerScript: string;
let miniflare: Miniflare;
let database: D1Database;
let logs: StructuredLog[];

const api = async (
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown> & { status: number }> => {
  const response = await miniflare.dispatchFetch(
    'https://lead-desk.test' + path,
    {
      headers: { 'Content-Type': 'application/json', ...headers },
      method,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    },
  );
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = { raw: raw.slice(0, 200) };
  }

  return { status: response.status, ...json };
};

const requestLines = (from: number, method: string, path: string) =>
  logs
    .slice(from)
    .filter((entry) => {
      try {
        const parsed = JSON.parse(entry.message) as Record<string, unknown>;
        return parsed.method === method && parsed.path === path;
      } catch {
        return false;
      }
    })
    .map((entry) => ({
      level: entry.level,
      parsed: JSON.parse(entry.message) as Record<string, unknown>,
    }));

beforeAll(async () => {
  await assertRepoRoot();
  const bundled = await build({
    bundle: true,
    entryPoints: [join(repoRoot, 'src/worker-global.ts')],
    external: ['cloudflare:*', 'node:*'],
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: join(repoRoot, 'tsconfig.json'),
    write: false,
  });
  workerScript = bundled.outputFiles[0].text;
}, 60_000);

beforeEach(async () => {
  logs = [];
  miniflare = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        DEV_ADMIN_EMAIL: 'logging@example.test',
        ENVIRONMENT: 'test',
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      handleStructuredLogs: (entry) => {
        logs.push({ level: entry.level, message: entry.message });
      },
      modules: true,
      script: workerScript,
    }),
  );
  database = await miniflare.getD1Database('DB');
  const names = (await readdir(join(repoRoot, 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .toSorted();
  for (const name of names) {
    const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
    for (const statement of sql
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
}, 60_000);

afterEach(async () => {
  await miniflare?.dispose();
}, 30_000);

test('every API request emits one JSON line with method, path, status, and durationMs', async () => {
  const result = await api('/health');
  expect(result.status).toBe(200);

  expect(logs).toHaveLength(1);
  const parsed = JSON.parse(logs[0].message) as Record<string, unknown>;
  expect(parsed).toMatchObject({
    event: 'request',
    method: 'GET',
    path: '/health',
    status: 200,
  });
  expect(typeof parsed.durationMs).toBe('number');
  expect((parsed.durationMs as number) >= 0).toBe(true);
  expect(logs[0].level).toBe('log');
});

test('the contacts query param is contact data and never reaches the logs', async () => {
  await api('/v1/contacts?query=secret-lead@example.test&limit=5');

  const lines = requestLines(0, 'GET', '/v1/contacts');
  expect(lines).toHaveLength(1);
  expect(lines[0].parsed.path).toBe('/v1/contacts');
  expect(lines[0].parsed.status).toBe(200);
  const raw = logs.map((entry) => entry.message).join('\n');
  expect(raw).not.toContain('secret-lead@example.test');
  expect(raw).not.toContain('query=');
  expect(raw).not.toContain('limit=5');
});

test('an unknown API route is logged with the 404 status at log level', async () => {
  const result = await api('/v1/definitely-not-a-route');
  expect(result.status).toBe(404);

  const lines = requestLines(0, 'GET', '/v1/definitely-not-a-route');
  expect(lines).toHaveLength(1);
  expect(lines[0].parsed.status).toBe(404);
  expect(lines[0].parsed.event).toBe('request');
  expect(lines[0].level).toBe('log');
});

test('a persistence failure is logged at error level with the class, never the cause message', async () => {
  const field = await api('/v1/custom-fields', 'POST', {
    entityType: 'contact',
    key: 'logging_probe',
    label: 'logging probe',
    type: 'text',
  });
  expect(field.status).toBe(201);

  await database
    .prepare(
      "CREATE TRIGGER logging_fail_insert BEFORE INSERT ON custom_field_values WHEN NEW.value_text = 'reject-value' BEGIN SELECT RAISE(ABORT, 'logging regression injected failure'); END",
    )
    .run();
  try {
    const result = await api('/v1/contacts', 'POST', {
      customFields: { logging_probe: 'reject-value' },
      email: 'logging-new@example.test',
      firstName: 'New',
    });
    expect(result.status).toBe(500);

    const lines = requestLines(0, 'POST', '/v1/contacts');
    const failure = lines.find(
      (line) => line.parsed.event === 'request.failure',
    );
    const request = lines.find((line) => line.parsed.event === 'request');
    expect(failure, 'no request.failure line').toBeDefined();
    expect(request, 'no request line').toBeDefined();
    if (failure === undefined || request === undefined) {
      throw new Error('expected request log lines to be present');
    }

    expect(failure.level).toBe('error');
    expect(request.level).toBe('error');
    expect(request.parsed.status).toBe(500);
    expect(failure.parsed).toMatchObject({
      errorClass: 'PersistenceError',
      status: 500,
    });
    expect(typeof failure.parsed.errorCauseClass).toBe('string');
    // The trigger message (and any SQL with bound values) must not leak.
    const raw = logs.map((entry) => entry.message).join('\n');
    expect(raw).not.toContain('logging regression injected failure');
    expect(raw).not.toContain('reject-value');
    expect(raw).not.toContain('logging-new@example.test');
  } finally {
    await database.prepare('DROP TRIGGER logging_fail_insert').run();
  }
});

test('the intake 413 path is logged with its final status and no body or token', async () => {
  const created = await api('/v1/tokens', 'POST', {
    name: 'logging-intake-token',
  });
  expect(created.status).toBe(201);
  const tokenValue = (created.data as { id: string; token: string }).token;

  const result = await api(
    '/v1/intakes',
    'POST',
    JSON.stringify({ notes: 'x'.repeat(70_000) }),
    { Authorization: `Bearer ${tokenValue}`, 'Idempotency-Key': 'logging-413' },
  );
  expect(result.status).toBe(413);

  const lines = requestLines(0, 'POST', '/v1/intakes');
  expect(lines).toHaveLength(1);
  expect(lines[0].parsed.event).toBe('request');
  expect(lines[0].parsed.status).toBe(413);
  expect(lines[0].level).toBe('log');
  const raw = logs.map((entry) => entry.message).join('\n');
  expect(raw).not.toContain(tokenValue);
  expect(raw).not.toContain('logging-413');
  expect(raw).not.toContain('"notes"');
});
