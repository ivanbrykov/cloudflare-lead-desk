import { DEFAULT_PIPELINE_ID, DEFAULT_WORKSPACE_ID } from '@/db/repository';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * D1-backed regression tests for the intake integrity and replay contract:
 * request fingerprints, replay/conflict/legacy handling, pipeline routing,
 * token rotation, key validation, and the bounded raw-body limit.
 *
 * Every test builds its own Miniflare + in-memory D1 fixture (migrations
 * applied from drizzle/), so tests are independently runnable and never rely
 * on setup performed by a preceding test.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `Intake D1 tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

const LEGACY_LEAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const TABLES = ['leads', 'activities', 'idempotency_keys'];

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .toSorted()
            .map((key) => [
              key,
              canonical((value as Record<string, unknown>)[key]),
            ]),
        )
      : value;

const reverse = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverse)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .toReversed()
            .map(([key, entry]) => [key, reverse(entry)]),
        )
      : value;

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

type IntakePayload = {
  customFields?: Record<string, unknown>;
  email: string;
  estimatedValue?: number;
  firstName?: string;
  lastName?: string;
  name?: string;
  pipelineId?: string;
  source: string;
  stageId?: string;
};

const payload = (email = 'intake-test@example.test'): IntakePayload => ({
  email,
  firstName: 'Alex',
  name: 'New inquiry',
  source: 'website_form',
});

type Fixture = {
  api: (
    path: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  count: (table: string) => Promise<number>;
  createToken: (name?: string) => Promise<{ id: string; token: string }>;
  db: D1Database;
  dispose: () => Promise<void>;
  intake: (
    key: string | undefined,
    input?: IntakePayload | string,
    authToken?: string,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  ok: <T>(
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<T>;
  raw: (
    path: string,
    method: string,
    body?: ReadableStream<Uint8Array<ArrayBuffer>> | string,
    headers?: Record<string, string>,
  ) => Promise<{ json: Record<string, unknown>; status: number }>;
  snapshot: () => Promise<Record<string, unknown[]>>;
};

const workerScripts = new Map<string, string>();

const bundleWorker = async (): Promise<string> => {
  const cached = workerScripts.get('default');
  if (cached) {
    return cached;
  }

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
  const script = bundled.outputFiles[0].text;
  workerScripts.set('default', script);
  return script;
};

/**
 * Starts a fresh in-memory D1 fixture. With `legacy: true` an idempotency
 * row is inserted BETWEEN the first and second migration, mirroring a
 * production database that accepted intakes before the additive
 * request_hash migration existed.
 */
const startFixture = async (
  options: { legacy?: boolean } = {},
): Promise<Fixture> => {
  const script = await bundleWorker();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        DEV_ADMIN_EMAIL: 'intake-regression@example.test',
        ENVIRONMENT: 'test',
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script,
    }),
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }

    disposed = true;
    await mf.dispose();
  };

  try {
    const database = await mf.getD1Database('DB');
    const names = (await readdir(join(repoRoot, 'drizzle')))
      .filter((name) => name.endsWith('.sql'))
      .toSorted();
    for (const [index, name] of names.entries()) {
      const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((chunk) => chunk.trim())
        .filter(Boolean)) {
        await database.prepare(statement).run();
      }

      if (options.legacy && index === 0) {
        await database
          .prepare(
            'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(
            DEFAULT_WORKSPACE_ID,
            'default',
            'Lead Desk',
            '2026-01-01',
            '2026-01-01',
          )
          .run();
        await database
          .prepare(
            'INSERT INTO idempotency_keys (workspace_id, key, response_json, created_at) VALUES (?, ?, ?, ?)',
          )
          .bind(
            DEFAULT_WORKSPACE_ID,
            'legacy-key',
            JSON.stringify({
              created: true,
              leadId: LEGACY_LEAD_ID,
            }),
            '2026-01-01',
          )
          .run();
      }
    }

    const raw = async (
      path: string,
      method = 'GET',
      body?: ReadableStream<Uint8Array<ArrayBuffer>> | string,
      headers: Record<string, string> = {},
    ): Promise<{ json: Record<string, unknown>; status: number }> => {
      // The stream body and its duplex mode are not modelled by the
      // RequestInit type here; both are supported by the runtime.
      const init: Record<string, unknown> = {
        headers: { 'Content-Type': 'application/json', ...headers },
        method,
      };
      if (body !== undefined) {
        if (body instanceof ReadableStream) {
          init.duplex = 'half';
        }

        init.body = body;
      }

      const response = await mf.dispatchFetch(
        `https://intake-test.example${path}`,
        init as unknown as Parameters<Miniflare['dispatchFetch']>[1],
      );
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 200) };
      }

      return { json, status: response.status };
    };

    const api = (
      path: string,
      method = 'GET',
      body?: unknown,
      headers?: Record<string, string>,
    ) =>
      raw(
        path,
        method,
        body === undefined ? undefined : JSON.stringify(body),
        headers,
      );
    const ok = async <T>(
      path: string,
      method = 'GET',
      body?: unknown,
      headers?: Record<string, string>,
    ): Promise<T> => {
      const result = await api(path, method, body, headers);
      expect(
        result.status >= 200 && result.status < 300,
        `${method} ${path} -> ${result.status}: ${JSON.stringify(result)}`,
      ).toBe(true);
      return result.json.data as T;
    };

    let lastToken: { id: string; token: string };

    const intake = (
      key: string | undefined,
      input: IntakePayload | string = payload(),
      authToken?: string,
    ) => {
      const token = authToken ?? lastToken.token;
      const body = typeof input === 'string' ? input : JSON.stringify(input);
      return raw('/v1/intakes', 'POST', body, {
        Authorization: `Bearer ${token}`,
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      });
    };

    return {
      api,
      count: async (table: string) =>
        ((await database.prepare(`SELECT count(*) AS n FROM ${table}`).first())
          ?.n ?? 0) as number,
      createToken: async (name) => {
        lastToken = await ok<{ id: string; token: string }>(
          '/v1/tokens',
          'POST',
          {
            name: name ?? 'intake-test-token',
          },
        );
        return lastToken;
      },
      db: database,
      dispose,
      intake,
      ok,
      raw,
      snapshot: async () =>
        Object.fromEntries(
          await Promise.all(
            TABLES.map(
              async (table) =>
                [
                  table,
                  (await database.prepare(`SELECT * FROM ${table}`).all())
                    .results,
                ] as [string, unknown[]],
            ),
          ),
        ),
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const expectError = (
  result: { json: Record<string, unknown>; status: number },
  status: number,
  code: string,
) => {
  expect(result.status, JSON.stringify(result)).toBe(status);
  expect(result.json.code).toBe(code);
};

const stream = (text: string): ReadableStream<Uint8Array<ArrayBuffer>> =>
  new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      for (let offset = 0; offset < bytes.length; offset += 777) {
        controller.enqueue(bytes.slice(offset, offset + 777));
      }

      controller.close();
    },
  });

test('same-key replay preserves the original response and writes nothing new', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const payloadValue = payload('REPLAY@Example.Test');
    payloadValue.customFields = {};
    const first = await fx.intake('replay-key', payloadValue, token.token);
    expect(first.status).toBe(201);
    const leadId = (first.json.data as { leadId: string }).leadId;
    expect(leadId).toMatch(/^[0-7][\dA-HJKMNP-TV-Z]{25}$/u);
    const before = await fx.snapshot();

    // Property order reversed and email case normalized: still the same
    // logical submission. (Surrounding whitespace is rejected earlier by the
    // static email schema, so case is the normalization axis here.)
    const reordered = reverse(payloadValue) as IntakePayload;
    reordered.email = 'replay@example.test';
    const replay = await fx.intake('replay-key', reordered, token.token);
    expect(replay.status, JSON.stringify(replay)).toBe(201);
    expect(replay.json.data).toEqual(first.json.data);
    expect(await fx.snapshot()).toEqual(before);
    expect(await fx.count('leads')).toBe(1);
    expect(await fx.count('leads')).toBe(1);
    expect(await fx.count('activities')).toBe(1);
    expect(await fx.count('idempotency_keys')).toBe(1);

    const row = await fx.db
      .prepare('SELECT request_hash FROM idempotency_keys WHERE key = ?')
      .bind('replay-key')
      .first();
    expect(row?.request_hash).toMatch(/^[\da-f]{64}$/u);
    const expected = {
      ...payloadValue,
      email: 'replay@example.test',
    };
    expect(row?.request_hash).toBe(
      sha256Hex(JSON.stringify(canonical(expected))),
    );
  } finally {
    await fx.dispose();
  }
});

test('a different payload under the same key conflicts without side effects', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const first = await fx.intake('collision-key', payload(), token.token);
    expect(first.status).toBe(201);
    const before = await fx.snapshot();

    const changed = payload();
    changed.firstName = 'Must not overwrite';
    const conflict = await fx.intake('collision-key', changed, token.token);
    expectError(conflict, 409, 'idempotency_conflict');
    expect(JSON.stringify(conflict.json)).not.toContain('Must not overwrite');
    expect(await fx.snapshot()).toEqual(before);
  } finally {
    await fx.dispose();
  }
});

test('parallel identical retries collapse and parallel conflicting requests choose one winner', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const identical = await Promise.all(
      Array.from({ length: 5 }, () =>
        fx.intake('parallel-same', payload(), token.token),
      ),
    );
    const first = identical[0];
    expect(first.status).toBe(201);
    const firstId = (first.json.data as { leadId: string }).leadId;
    for (const result of identical) {
      expect(result.status).toBe(201);
      expect((result.json.data as { leadId: string }).leadId).toBe(firstId);
    }

    expect(await fx.count('leads')).toBe(1);

    const a = payload('conflict-pair@example.test');
    const b = payload('conflict-pair@example.test');
    a.name = 'Winner A';
    b.name = 'Winner B';
    const pair = await Promise.all([
      fx.intake('parallel-conflict', a, token.token),
      fx.intake('parallel-conflict', b, token.token),
    ]);
    expect(pair.map((result) => result.status).toSorted()).toEqual([201, 409]);
    const winnerIndex = pair[0].status === 201 ? 0 : 1;
    const loserIndex = 1 - winnerIndex;
    expectError(pair[loserIndex], 409, 'idempotency_conflict');
    const winnerId = (pair[winnerIndex].json.data as { leadId: string }).leadId;
    const saved = await fx.db
      .prepare('SELECT name FROM leads WHERE id = ?')
      .bind(winnerId)
      .first();
    expect(saved?.name).toBe([a, b][winnerIndex].name);
    expect(await fx.count('leads')).toBe(2);
    expect(await fx.count('leads')).toBe(2);
    expect(await fx.count('activities')).toBe(2);
    expect(await fx.count('idempotency_keys')).toBe(2);
  } finally {
    await fx.dispose();
  }
});

test('distinct keys create separate leads even for the same email', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const a = await fx.intake(
      'distinct-a',
      payload('DUP@Example.Test'),
      token.token,
    );
    const b = await fx.intake(
      'distinct-b',
      payload('dup@example.test'),
      token.token,
    );
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aId = (a.json.data as { leadId: string }).leadId;
    const bId = (b.json.data as { leadId: string }).leadId;
    expect(aId).not.toBe(bId);
    // Leads are not deduplicated: one submission creates one lead.
    expect(await fx.count('leads')).toBe(2);
    expect(await fx.count('activities')).toBe(2);
    const stored = await fx.db
      .prepare('SELECT normalized_email FROM leads ORDER BY created_at')
      .all<{ normalized_email: string }>();
    expect(stored.results?.map((row) => row.normalized_email)).toEqual([
      'dup@example.test',
      'dup@example.test',
    ]);
  } finally {
    await fx.dispose();
  }
});

test('invalid or foreign pipeline-stage pairs reject atomically', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const other = await fx.ok<{ id: string }>('/v1/pipelines', 'POST', {
      name: 'Other',
    });
    const stage = await fx.ok<{ id: string }>(
      `/v1/pipelines/${other.id}/stages`,
      'POST',
      { name: 'Other stage' },
    );
    const before = await fx.snapshot();

    const mismatch = payload('mismatch@example.test');
    mismatch.pipelineId = DEFAULT_PIPELINE_ID;
    mismatch.stageId = stage.id;
    expectError(
      await fx.intake('routing-mismatch', mismatch, token.token),
      422,
      'invalid_stage',
    );

    const missing = payload('missing@example.test');
    missing.pipelineId = other.id;
    missing.stageId = '01ARZ3NDEKTSV4RRFFQ69G5FC0';
    expectError(
      await fx.intake('routing-missing', missing, token.token),
      422,
      'invalid_stage',
    );

    await fx.db
      .prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?')
      .bind(Date.parse('2026-09-09T00:00:00.000Z'), other.id)
      .run();
    const archived = payload('archived@example.test');
    archived.pipelineId = other.id;
    archived.stageId = stage.id;
    expectError(
      await fx.intake('routing-archived', archived, token.token),
      422,
      'invalid_stage',
    );

    await fx.db
      .prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?')
      .bind(Date.parse('2026-09-09T00:00:00.000Z'), DEFAULT_PIPELINE_ID)
      .run();
    expectError(
      await fx.intake('routing-default-archived', payload(), token.token),
      422,
      'invalid_stage',
    );

    const foreignWorkspace = '01ARZ3NDEKTSV4RRFFQ69G5FC1';
    await fx.db
      .prepare(
        'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        foreignWorkspace,
        'foreign',
        'Foreign',
        Date.parse('2026-01-01T00:00:00.000Z'),
        Date.parse('2026-01-01T00:00:00.000Z'),
      )
      .run();
    await fx.db
      .prepare(
        'UPDATE pipelines SET archived_at = NULL, workspace_id = ? WHERE id = ?',
      )
      .bind(foreignWorkspace, other.id)
      .run();
    await fx.db
      .prepare('UPDATE stages SET workspace_id = ? WHERE id = ?')
      .bind(foreignWorkspace, stage.id)
      .run();
    const foreign = payload('foreign@example.test');
    foreign.pipelineId = other.id;
    foreign.stageId = stage.id;
    expectError(
      await fx.intake('routing-foreign', foreign, token.token),
      422,
      'invalid_stage',
    );

    expect(await fx.snapshot()).toEqual(before);
    for (const table of TABLES) {
      expect(
        await fx.count(table),
        `${table} rows written by rejected intake`,
      ).toBe(0);
    }
  } finally {
    await fx.dispose();
  }
});

test('an accepted replay survives an archived pipeline', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const acceptedPayload = payload('mutable@example.test');
    const accepted = await fx.intake(
      'mutable-key',
      acceptedPayload,
      token.token,
    );
    expect(accepted.status).toBe(201);

    await fx.db
      .prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?')
      .bind(Date.parse('2026-09-09T00:00:00.000Z'), DEFAULT_PIPELINE_ID)
      .run();
    const before = await fx.snapshot();

    const replay = await fx.intake('mutable-key', acceptedPayload, token.token);
    expect(replay.status, JSON.stringify(replay)).toBe(201);
    expect(replay.json.data).toEqual(accepted.json.data);
    expect(await fx.snapshot()).toEqual(before);

    const changed = structuredClone(acceptedPayload);
    changed.name = 'Changed';
    const conflict = await fx.intake('mutable-key', changed, token.token);
    expectError(conflict, 409, 'idempotency_conflict');
    expect(JSON.stringify(conflict.json)).not.toContain('request_hash');
    expect(await fx.snapshot()).toEqual(before);
  } finally {
    await fx.dispose();
  }
});

test('a failed intake transaction reserves nothing and the same key can retry', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const before = await fx.snapshot();
    const makePayload = () => {
      const value = payload('rollback@example.test');
      value.firstName = 'Updated';
      return value;
    };

    await fx.db
      .prepare(
        "CREATE TRIGGER intake_fail BEFORE INSERT ON activities WHEN NEW.kind = 'intake' BEGIN SELECT RAISE(ABORT, 'intake regression injected failure'); END",
      )
      .run();
    try {
      const failed = await fx.intake(
        'retryable-key',
        makePayload(),
        token.token,
      );
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.json)).not.toContain('injected failure');
      // Nothing partial: no lead, no activity, and no key reserved.
      expect(await fx.snapshot()).toEqual(before);
      expect(await fx.count('idempotency_keys')).toBe(0);
    } finally {
      await fx.db.prepare('DROP TRIGGER intake_fail').run();
    }

    // The failed transaction reserved no key, so the same key can now
    // succeed and complete the original submission.
    const retry = await fx.intake('retryable-key', makePayload(), token.token);
    expect(retry.status, JSON.stringify(retry)).toBe(201);
    const lead = await fx.db
      .prepare('SELECT first_name FROM leads WHERE email = ?')
      .bind('rollback@example.test')
      .first<{ first_name: string }>();
    expect(lead?.first_name).toBe('Updated');
    expect(await fx.count('idempotency_keys')).toBe(1);
  } finally {
    await fx.dispose();
  }
});

test('a pre-fingerprint idempotency row survives the additive migration as unverifiable', async () => {
  const fx = await startFixture({ legacy: true });
  try {
    const token = await fx.createToken();
    const before = await fx.snapshot();

    const result = await fx.intake(
      'legacy-key',
      payload('legacy@example.test'),
      token.token,
    );
    expectError(result, 409, 'idempotency_legacy_unverifiable');
    expect(result.json.details).toEqual({
      leadId: LEGACY_LEAD_ID,
    });
    expect(await fx.snapshot()).toEqual(before);

    const row = await fx.db
      .prepare(
        'SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?',
      )
      .bind('legacy-key')
      .first();
    expect(row?.request_hash).toBeNull();
    expect(JSON.parse(String(row?.response_json)).leadId).toBe(LEGACY_LEAD_ID);

    // A different key is still a normal new submission against the same store.
    const fresh = await fx.intake('fresh-after-legacy', payload(), token.token);
    expect(fresh.status).toBe(201);
    expect(await fx.count('idempotency_keys')).toBe(2);
  } finally {
    await fx.dispose();
  }
});

test('key validation, revocation, and token rotation reject or replay without writes', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const before = await fx.snapshot();

    expectError(
      await fx.intake(undefined, payload(), token.token),
      400,
      'idempotency_key_required',
    );
    expectError(
      await fx.intake('k'.repeat(129), payload(), token.token),
      400,
      'invalid_idempotency_key',
    );
    expectError(
      await fx.intake('contains space', payload(), token.token),
      400,
      'invalid_idempotency_key',
    );
    expect(await fx.snapshot()).toEqual(before);

    expect((await fx.intake('k', payload(), token.token)).status).toBe(201);
    expect(
      (
        await fx.intake(
          'k'.repeat(128),
          payload('boundary@example.test'),
          token.token,
        )
      ).status,
    ).toBe(201);

    const accepted = await fx.intake(
      'rotation-key',
      payload('rotation@example.test'),
      token.token,
    );
    expect(accepted.status).toBe(201);
    const afterAccepted = await fx.snapshot();

    await fx.ok(`/v1/tokens/${token.id}`, 'DELETE');
    const revoked = await fx.intake(
      'rotation-key',
      payload('rotation@example.test'),
      token.token,
    );
    expect(revoked.status).toBe(401);
    expect(await fx.snapshot()).toEqual(afterAccepted);

    const replacement = await fx.createToken('replacement');
    const rotated = await fx.intake(
      'rotation-key',
      payload('rotation@example.test'),
      replacement.token,
    );
    expect(rotated.status).toBe(201);
    expect(rotated.json.data).toEqual(accepted.json.data);
    expect(await fx.snapshot()).toEqual(afterAccepted);
  } finally {
    await fx.dispose();
  }
});

test('oversized intake bodies are rejected before parsing and the exact limit is allowed', async () => {
  const fx = await startFixture();
  try {
    const token = await fx.createToken();
    const before = await fx.snapshot();
    const input = JSON.stringify(payload());
    const byteLength = new TextEncoder().encode(input).length;

    const oversized = input + ' '.repeat(65_537 - byteLength);
    const headers = {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'too-big',
    };

    // Streamed body, no Content-Length at all.
    expectError(
      await fx.raw('/v1/intakes', 'POST', stream(oversized), headers),
      413,
      'payload_too_large',
    );
    // Multi-byte characters: the limit is on actual bytes, not JS chars.
    const unicode = payload('unicode@example.test');
    unicode.source = '\u{1F600}'.repeat(17_000);
    expectError(
      await fx.raw(
        '/v1/intakes',
        'POST',
        stream(JSON.stringify(unicode)),
        headers,
      ),
      413,
      'payload_too_large',
    );
    // Declared Content-Length over the limit.
    expectError(
      await fx.raw('/v1/intakes', 'POST', oversized, {
        ...headers,
        'Content-Length': String(new TextEncoder().encode(oversized).length),
      }),
      413,
      'payload_too_large',
    );
    expect(await fx.snapshot()).toEqual(before);

    // The exact boundary is allowed.
    const exact = input + ' '.repeat(65_536 - byteLength);
    const boundary = await fx.raw('/v1/intakes', 'POST', stream(exact), {
      ...headers,
      'Idempotency-Key': 'max-size',
    });
    expect(boundary.status, JSON.stringify(boundary)).toBe(201);
    expect(await fx.count('leads')).toBe(1);
    expect(await fx.count('idempotency_keys')).toBe(1);
  } finally {
    await fx.dispose();
  }
});

test('the byte limit applies to the intake route only', async () => {
  const fx = await startFixture();
  try {
    const big = 'x'.repeat(70_000);
    const pipeline = await fx.api('/v1/pipelines', 'POST', { name: big });
    expect(pipeline.status).toBe(201);

    const lead = await fx.api('/v1/leads', 'POST', {
      email: 'big@example.test',
      firstName: big,
      source: 'manual',
    });
    expect(lead.status).toBe(201);
  } finally {
    await fx.dispose();
  }
});
