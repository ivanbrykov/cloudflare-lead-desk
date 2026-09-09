import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  DEFAULT_PIPELINE_ID,
  DEFAULT_STAGE_ID,
  DEFAULT_WORKSPACE_ID,
} from '@/db/repository';

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

const LEGACY_OPPORTUNITY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const TABLES = [
  'contacts',
  'opportunities',
  'activities',
  'custom_field_values',
  'idempotency_keys',
];

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;

const reverse = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverse)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, entry]) => [key, reverse(entry)]),
        )
      : value;

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

interface IntakePayload {
  contact: {
    customFields?: Record<string, unknown>;
    email: string;
    firstName?: string;
    lastName?: string;
  };
  opportunity: {
    customFields?: Record<string, unknown>;
    estimatedValue?: number;
    name: string;
    pipelineId?: string;
    source: string;
    stageId?: string;
  };
  source: string;
}

const payload = (email = 'intake-test@example.test'): IntakePayload => ({
  contact: { email, firstName: 'Alex' },
  opportunity: { name: 'New inquiry', source: 'form' },
  source: 'website_form',
});

interface Fixture {
  db: D1Database;
  dispose(): Promise<void>;
  raw(
    path: string,
    method: string,
    body?: string | ReadableStream<Uint8Array<ArrayBuffer>>,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  api(
    path: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  ok<T>(
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T>;
  createToken(name?: string): Promise<{ id: string; token: string }>;
  intake(
    key: string | undefined,
    input?: string | IntakePayload,
    authToken?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  snapshot(): Promise<Record<string, unknown[]>>;
  count(table: string): Promise<number>;
}

let workerScript: string | null = null;

const bundleWorker = async (): Promise<string> => {
  if (workerScript) return workerScript;
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
  return workerScript;
};

/**
 * Starts a fresh in-memory D1 fixture. With `legacy: true` an idempotency
 * row is inserted BETWEEN the first and second migration, mirroring a
 * production database that accepted intakes before the additive
 * request_hash migration existed.
 */
const startFixture = async (options: { legacy?: boolean } = {}): Promise<Fixture> => {
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
    if (disposed) return;
    disposed = true;
    await mf.dispose();
  };
  try {
    const db = await mf.getD1Database('DB');
    const names = (await readdir(join(repoRoot, 'drizzle')))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (let index = 0; index < names.length; index += 1) {
      const sql = await readFile(join(repoRoot, 'drizzle', names[index]), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean)) {
        await db.prepare(statement).run();
      }
      if (options.legacy && index === 0) {
        await db
          .prepare(
            'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(DEFAULT_WORKSPACE_ID, 'default', 'Lead Desk', '2026-01-01', '2026-01-01')
          .run();
        await db
          .prepare(
            'INSERT INTO idempotency_keys (workspace_id, key, response_json, created_at) VALUES (?, ?, ?, ?)',
          )
          .bind(
            DEFAULT_WORKSPACE_ID,
            'legacy-key',
            JSON.stringify({ created: true, opportunityId: LEGACY_OPPORTUNITY_ID }),
            '2026-01-01',
          )
          .run();
      }
    }

    const raw = async (
      path: string,
      method = 'GET',
      body?: string | ReadableStream<Uint8Array<ArrayBuffer>>,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; json: Record<string, unknown> }> => {
      // The stream body and its duplex mode are not modelled by the
      // RequestInit type here; both are supported by the runtime.
      const init: Record<string, unknown> = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
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
      return { status: response.status, json };
    };
    const api = (
      path: string,
      method = 'GET',
      body?: unknown,
      headers?: Record<string, string>,
    ) => raw(path, method, body === undefined ? undefined : JSON.stringify(body), headers);
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
    const createToken = (name = 'intake-test-token') =>
      ok<{ id: string; token: string }>('/v1/tokens', 'POST', { name });
    const intake = (
      key: string | undefined,
      input: string | IntakePayload = payload(),
      authToken?: string,
    ) => {
      const token = authToken ?? lastToken.token;
      const body = typeof input === 'string' ? input : JSON.stringify(input);
      return raw('/v1/intakes', 'POST', body, {
        Authorization: `Bearer ${token}`,
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      });
    };
    let lastToken: { id: string; token: string };

    return {
      count: async (table: string) =>
        ((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first())?.n ?? 0) as number,
      createToken: async (name) => {
        lastToken = await ok<{ id: string; token: string }>('/v1/tokens', 'POST', {
          name: name ?? 'intake-test-token',
        });
        return lastToken;
      },
      db,
      dispose,
      intake,
      ok,
      raw,
      api,
      snapshot: async () =>
        Object.fromEntries(
          await Promise.all(
            TABLES.map(
              async (table) =>
                [
                  table,
                  (await db.prepare(`SELECT * FROM ${table}`).all()).results,
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
  result: { status: number; json: Record<string, unknown> },
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
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const payloadValue = payload('REPLAY@Example.Test');
    payloadValue.contact.customFields = {};
    const first = await f.intake('replay-key', payloadValue, token.token);
    expect(first.status).toBe(201);
    const opportunityId = (first.json.data as { opportunityId: string }).opportunityId;
    expect(opportunityId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const before = await f.snapshot();

    // Property order reversed and email case normalized: still the same
    // logical submission. (Surrounding whitespace is rejected earlier by the
    // static email schema, so case is the normalization axis here.)
    const reordered = reverse(payloadValue) as IntakePayload;
    reordered.contact.email = 'replay@example.test';
    const replay = await f.intake('replay-key', reordered, token.token);
    expect(replay.status, JSON.stringify(replay)).toBe(201);
    expect(replay.json.data).toEqual(first.json.data);
    expect(await f.snapshot()).toEqual(before);
    expect(await f.count('contacts')).toBe(1);
    expect(await f.count('opportunities')).toBe(1);
    expect(await f.count('activities')).toBe(1);
    expect(await f.count('idempotency_keys')).toBe(1);

    const row = await f.db
      .prepare('SELECT request_hash FROM idempotency_keys WHERE key = ?')
      .bind('replay-key')
      .first();
    expect(row?.request_hash).toMatch(/^[a-f0-9]{64}$/);
    const expected = {
      ...payloadValue,
      contact: { ...payloadValue.contact, email: 'replay@example.test' },
    };
    expect(row?.request_hash).toBe(sha256Hex(JSON.stringify(canonical(expected))));
  } finally {
    await f.dispose();
  }
});

test('a different payload under the same key conflicts without side effects', async () => {
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const first = await f.intake('collision-key', payload(), token.token);
    expect(first.status).toBe(201);
    const before = await f.snapshot();

    const changed = payload();
    changed.contact.firstName = 'Must not overwrite';
    const conflict = await f.intake('collision-key', changed, token.token);
    expectError(conflict, 409, 'idempotency_conflict');
    expect(JSON.stringify(conflict.json)).not.toContain('Must not overwrite');
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.dispose();
  }
});

test('parallel identical retries collapse and parallel conflicting requests choose one winner', async () => {
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const identical = await Promise.all(
      Array.from({ length: 5 }, () => f.intake('parallel-same', payload(), token.token)),
    );
    const first = identical[0];
    expect(first.status).toBe(201);
    const firstId = (first.json.data as { opportunityId: string }).opportunityId;
    for (const result of identical) {
      expect(result.status).toBe(201);
      expect((result.json.data as { opportunityId: string }).opportunityId).toBe(firstId);
    }
    expect(await f.count('opportunities')).toBe(1);

    const a = payload('conflict-pair@example.test');
    const b = payload('conflict-pair@example.test');
    a.opportunity.name = 'Winner A';
    b.opportunity.name = 'Winner B';
    const pair = await Promise.all([
      f.intake('parallel-conflict', a, token.token),
      f.intake('parallel-conflict', b, token.token),
    ]);
    expect(pair.map((result) => result.status).sort()).toEqual([201, 409]);
    const winnerIndex = pair[0].status === 201 ? 0 : 1;
    const loserIndex = 1 - winnerIndex;
    expectError(pair[loserIndex], 409, 'idempotency_conflict');
    const winnerId = (pair[winnerIndex].json.data as { opportunityId: string }).opportunityId;
    const saved = await f.db
      .prepare('SELECT name FROM opportunities WHERE id = ?')
      .bind(winnerId)
      .first();
    expect(saved?.name).toBe([a, b][winnerIndex].opportunity.name);
    expect(await f.count('contacts')).toBe(2);
    expect(await f.count('opportunities')).toBe(2);
    expect(await f.count('activities')).toBe(2);
    expect(await f.count('idempotency_keys')).toBe(2);
  } finally {
    await f.dispose();
  }
});

test('distinct keys normalize the same email to one contact with separate inquiries', async () => {
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const a = await f.intake('distinct-a', payload('DUP@Example.Test'), token.token);
    const b = await f.intake('distinct-b', payload('dup@example.test'), token.token);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aId = (a.json.data as { opportunityId: string }).opportunityId;
    const bId = (b.json.data as { opportunityId: string }).opportunityId;
    expect(aId).not.toBe(bId);
    expect(await f.count('contacts')).toBe(1);
    expect(await f.count('opportunities')).toBe(2);
    expect(await f.count('activities')).toBe(2);
    const contact = await f.db
      .prepare('SELECT email, normalized_email FROM contacts')
      .first();
    expect(contact?.normalized_email).toBe('dup@example.test');
  } finally {
    await f.dispose();
  }
});

test('invalid or foreign pipeline-stage pairs reject atomically', async () => {
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const other = await f.ok<{ id: string }>('/v1/pipelines', 'POST', { name: 'Other' });
    const stage = await f.ok<{ id: string }>(
      `/v1/pipelines/${other.id}/stages`,
      'POST',
      { name: 'Other stage' },
    );
    const before = await f.snapshot();

    const mismatch = payload('mismatch@example.test');
    mismatch.opportunity.pipelineId = DEFAULT_PIPELINE_ID;
    mismatch.opportunity.stageId = stage.id;
    expectError(await f.intake('routing-mismatch', mismatch, token.token), 422, 'invalid_stage');

    const missing = payload('missing@example.test');
    missing.opportunity.pipelineId = other.id;
    missing.opportunity.stageId = '01ARZ3NDEKTSV4RRFFQ69G5FC0';
    expectError(await f.intake('routing-missing', missing, token.token), 422, 'invalid_stage');

    await f.db
      .prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?')
      .bind('2026-09-09', other.id)
      .run();
    const archived = payload('archived@example.test');
    archived.opportunity.pipelineId = other.id;
    archived.opportunity.stageId = stage.id;
    expectError(await f.intake('routing-archived', archived, token.token), 422, 'invalid_stage');

    await f.db
      .prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?')
      .bind('2026-09-09', DEFAULT_PIPELINE_ID)
      .run();
    expectError(
      await f.intake('routing-default-archived', payload(), token.token),
      422,
      'invalid_stage',
    );

    const foreignWorkspace = '01ARZ3NDEKTSV4RRFFQ69G5FC1';
    await f.db
      .prepare(
        'INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(foreignWorkspace, 'foreign', 'Foreign', '2026-01-01', '2026-01-01')
      .run();
    await f.db
      .prepare('UPDATE pipelines SET archived_at = NULL, workspace_id = ? WHERE id = ?')
      .bind(foreignWorkspace, other.id)
      .run();
    await f.db
      .prepare('UPDATE stages SET workspace_id = ? WHERE id = ?')
      .bind(foreignWorkspace, stage.id)
      .run();
    const foreign = payload('foreign@example.test');
    foreign.opportunity.pipelineId = other.id;
    foreign.opportunity.stageId = stage.id;
    expectError(await f.intake('routing-foreign', foreign, token.token), 422, 'invalid_stage');

    expect(await f.snapshot()).toEqual(before);
    for (const table of TABLES) {
      expect(await f.count(table), `${table} rows written by rejected intake`).toBe(0);
    }
  } finally {
    await f.dispose();
  }
});

test('an accepted replay survives archived fields, new required fields, and archived pipelines', async () => {
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const field = await f.ok<{ id: string }>('/v1/custom-fields', 'POST', {
      entityType: 'contact',
      key: 'old_field',
      label: 'Old',
      type: 'text',
    });
    const acceptedPayload = payload('mutable@example.test');
    acceptedPayload.contact.customFields = { old_field: 'historic' };
    const accepted = await f.intake('mutable-key', acceptedPayload, token.token);
    expect(accepted.status).toBe(201);

    await f.ok(`/v1/custom-fields/${field.id}`, 'DELETE');
    await f.ok('/v1/custom-fields', 'POST', {
      entityType: 'contact',
      key: 'new_required',
      label: 'New required',
      required: true,
      type: 'text',
    });
    await f.db
      .prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?')
      .bind('2026-09-09', DEFAULT_PIPELINE_ID)
      .run();
    const before = await f.snapshot();

    const replay = await f.intake('mutable-key', acceptedPayload, token.token);
    expect(replay.status, JSON.stringify(replay)).toBe(201);
    expect(replay.json.data).toEqual(accepted.json.data);
    expect(await f.snapshot()).toEqual(before);

    const changed = structuredClone(acceptedPayload);
    changed.opportunity.name = 'Changed';
    const conflict = await f.intake('mutable-key', changed, token.token);
    expectError(conflict, 409, 'idempotency_conflict');
    expect(JSON.stringify(conflict.json)).not.toContain('historic');
    expect(JSON.stringify(conflict.json)).not.toContain('request_hash');
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.dispose();
  }
});

test('a failed intake transaction reserves nothing and the same key can retry', async () => {
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const contact = await f.ok<{ id: string }>('/v1/contacts', 'POST', {
      email: 'rollback@example.test',
      firstName: 'Original',
    });
    const before = await f.snapshot();
    const makePayload = () => {
      const value = payload('rollback@example.test');
      value.contact.firstName = 'Updated';
      return value;
    };

    await f.db
      .prepare(
        "CREATE TRIGGER intake_fail BEFORE INSERT ON activities WHEN NEW.kind = 'intake' BEGIN SELECT RAISE(ABORT, 'intake regression injected failure'); END",
      )
      .run();
    try {
      const failed = await f.intake('retryable-key', makePayload(), token.token);
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.json)).not.toContain('injected failure');
      // Nothing partial: the contact is untouched and no key is reserved.
      expect(await f.snapshot()).toEqual(before);
      expect(await f.count('idempotency_keys')).toBe(0);
    } finally {
      await f.db.prepare('DROP TRIGGER intake_fail').run();
    }

    // The failed transaction reserved no key, so the same key can now
    // succeed and complete the original submission.
    const retry = await f.intake('retryable-key', makePayload(), token.token);
    expect(retry.status, JSON.stringify(retry)).toBe(201);
    const updated = await f.ok<{ firstName: string | null }>('/v1/contacts/' + contact.id);
    expect(updated.firstName).toBe('Updated');
    expect(await f.count('idempotency_keys')).toBe(1);
  } finally {
    await f.dispose();
  }
});

test('a pre-fingerprint idempotency row survives the additive migration as unverifiable', async () => {
  const f = await startFixture({ legacy: true });
  try {
    const token = await f.createToken();
    const before = await f.snapshot();

    const result = await f.intake('legacy-key', payload('legacy@example.test'), token.token);
    expectError(result, 409, 'idempotency_legacy_unverifiable');
    expect(result.json.details).toEqual({ opportunityId: LEGACY_OPPORTUNITY_ID });
    expect(await f.snapshot()).toEqual(before);

    const row = await f.db
      .prepare('SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?')
      .bind('legacy-key')
      .first();
    expect(row?.request_hash).toBeNull();
    expect(JSON.parse(String(row?.response_json)).opportunityId).toBe(LEGACY_OPPORTUNITY_ID);

    // A different key is still a normal new submission against the same store.
    const fresh = await f.intake('fresh-after-legacy', payload(), token.token);
    expect(fresh.status).toBe(201);
    expect(await f.count('idempotency_keys')).toBe(2);
  } finally {
    await f.dispose();
  }
});

test('key validation, revocation, and token rotation reject or replay without writes', async () => {
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const before = await f.snapshot();

    expectError(
      await f.intake(undefined, payload(), token.token),
      400,
      'idempotency_key_required',
    );
    expectError(
      await f.intake('k'.repeat(129), payload(), token.token),
      400,
      'invalid_idempotency_key',
    );
    expectError(
      await f.intake('contains space', payload(), token.token),
      400,
      'invalid_idempotency_key',
    );
    expect(await f.snapshot()).toEqual(before);

    expect((await f.intake('k', payload(), token.token)).status).toBe(201);
    expect((await f.intake('k'.repeat(128), payload('boundary@example.test'), token.token)).status).toBe(201);

    const accepted = await f.intake('rotation-key', payload('rotation@example.test'), token.token);
    expect(accepted.status).toBe(201);
    const afterAccepted = await f.snapshot();

    await f.ok(`/v1/tokens/${token.id}`, 'DELETE');
    const revoked = await f.intake('rotation-key', payload('rotation@example.test'), token.token);
    expect(revoked.status).toBe(401);
    expect(await f.snapshot()).toEqual(afterAccepted);

    const replacement = await f.createToken('replacement');
    const rotated = await f.intake(
      'rotation-key',
      payload('rotation@example.test'),
      replacement.token,
    );
    expect(rotated.status).toBe(201);
    expect(rotated.json.data).toEqual(accepted.json.data);
    expect(await f.snapshot()).toEqual(afterAccepted);
  } finally {
    await f.dispose();
  }
});

test('oversized intake bodies are rejected before parsing and the exact limit is allowed', async () => {
  const f = await startFixture();
  try {
    const token = await f.createToken();
    const before = await f.snapshot();
    const input = JSON.stringify(payload());
    const byteLength = new TextEncoder().encode(input).length;

    const oversized = input + ' '.repeat(65_537 - byteLength);
    const headers = {
      Authorization: `Bearer ${token.token}`,
      'Idempotency-Key': 'too-big',
    };

    // Streamed body, no Content-Length at all.
    expectError(
      await f.raw('/v1/intakes', 'POST', stream(oversized), headers),
      413,
      'payload_too_large',
    );
    // Multi-byte characters: the limit is on actual bytes, not JS chars.
    const unicode = payload('unicode@example.test');
    unicode.source = '\u{1F600}'.repeat(17_000);
    expectError(
      await f.raw('/v1/intakes', 'POST', stream(JSON.stringify(unicode)), headers),
      413,
      'payload_too_large',
    );
    // Declared Content-Length over the limit.
    expectError(
      await f.raw('/v1/intakes', 'POST', oversized, {
        ...headers,
        'Content-Length': String(new TextEncoder().encode(oversized).length),
      }),
      413,
      'payload_too_large',
    );
    expect(await f.snapshot()).toEqual(before);

    // The exact boundary is allowed.
    const exact = input + ' '.repeat(65_536 - byteLength);
    const boundary = await f.raw('/v1/intakes', 'POST', stream(exact), {
      ...headers,
      'Idempotency-Key': 'max-size',
    });
    expect(boundary.status, JSON.stringify(boundary)).toBe(201);
    expect(await f.count('opportunities')).toBe(1);
    expect(await f.count('idempotency_keys')).toBe(1);
  } finally {
    await f.dispose();
  }
});

test('the byte limit applies to the intake route only', async () => {
  const f = await startFixture();
  try {
    const big = 'x'.repeat(70_000);
    const pipeline = await f.api('/v1/pipelines', 'POST', { name: big });
    expect(pipeline.status).toBe(201);

    const contact = await f.api('/v1/contacts', 'POST', { email: 'big@example.test', firstName: big });
    expect(contact.status).toBe(201);
  } finally {
    await f.dispose();
  }
});
