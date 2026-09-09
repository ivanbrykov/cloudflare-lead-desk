import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';

/**
 * D1-backed regression tests for contact and custom-field correctness.
 *
 * The worker is bundled the same way as the external verifier and runs in
 * Miniflare against a real local D1 database (migrations applied from
 * drizzle/). Tests exercise the public API end to end and inspect storage
 * directly, including injected write failures via SQLite triggers.
 */

const repoRoot = process.cwd();
const assertRepoRoot = async () => {
  const entry = join(repoRoot, 'src/worker-global.ts');
  try {
    await readFile(entry);
  } catch {
    throw new Error(
      `D1 regression tests must run from the repository root (expected ${entry} to exist; cwd is ${repoRoot}).`,
    );
  }
};

interface Contact {
  createdAt: string;
  customFields: Record<string, unknown>;
  email: string | null;
  firstName: string | null;
  id: string;
  lastName: string | null;
}

interface ContactRecord {
  createdAt: string;
  email: string | null;
  firstName: string | null;
  id: string;
  lastName: string | null;
}

interface Opportunity {
  contact: ContactRecord;
  customFields: Record<string, unknown>;
  id: string;
  name: string;
}

let workerScript: string;
let miniflare: Miniflare;
let db: D1Database;

const api = async (
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number } & Record<string, unknown>> => {
  const response = await miniflare.dispatchFetch('https://lead-desk.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = { raw: raw.slice(0, 200) };
  }
  return { status: response.status, ...json };
};

const ok = async <T>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> => {
  const result = await api(path, method, body, headers);
  expect(
    result.status >= 200 && result.status < 300,
    `${method} ${path} -> ${result.status}: ${JSON.stringify(result)}`,
  ).toBe(true);
  return result.data as T;
};

const createField = async (key: string, type = 'text', required = false) =>
  ok<Record<string, unknown>>('/v1/custom-fields', 'POST', {
    entityType: 'contact',
    key,
    label: key,
    required,
    type,
    ...(type === 'select' ? { options: ['A', 'B'] } : {}),
  });

const createContact = (email: string, customFields?: Record<string, unknown>) =>
  ok<Contact>('/v1/contacts', 'POST', { email, firstName: 'Before', customFields });

const valueRow = (fieldKey: string, entityId: string) =>
  db
    .prepare(
      `SELECT v.value_text, v.value_number, v.value_boolean
       FROM custom_field_values v
       JOIN custom_field_definitions d ON d.id = v.field_definition_id
       WHERE v.entity_id = ? AND d.key = ?`,
    )
    .bind(entityId, fieldKey)
    .first();

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
  miniflare = new Miniflare(
    convertV4MiniflareOptions({
      bindings: {
        ACCESS_AUD: 'test',
        ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
        DEV_ADMIN_EMAIL: 'regression@example.test',
        ENVIRONMENT: 'test',
      },
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script: workerScript,
    }),
  );
  db = await miniflare.getD1Database('DB');
  const names = (await readdir(join(repoRoot, 'drizzle')))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names) {
    const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  await createField('active_bool', 'boolean');
  await createField('optional_text');
  await createField('optional_num', 'number');
  await createField('optional_date', 'date');
  await createField('optional_select', 'select');
}, 60_000);

afterEach(async () => {
  await miniflare?.dispose();
}, 30_000);

test('boolean false and every field type survive create, read, and unchanged update', async () => {
  const values = {
    active_bool: false,
    optional_date: '2026-09-08',
    optional_num: 2.5,
    optional_select: 'A',
    optional_text: 'hello',
  };
  const contact = await createContact('roundtrip@example.test', values);
  const read = await ok<Contact>('/v1/contacts/' + contact.id);
  expect(read.customFields).toEqual(values);
  expect(read.customFields.active_bool).toBe(false);

  const edit = await ok<Contact>('/v1/contacts/' + contact.id, 'PUT', {
    customFields: read.customFields,
    email: contact.email,
    firstName: 'After',
  });
  expect(edit.customFields).toEqual(values);
  expect(edit.firstName).toBe('After');
});

test('explicit null clears optional values; omission preserves them', async () => {
  const contact = await createContact('clear@example.test', {
    optional_date: '2026-09-08',
    optional_num: 7,
    optional_select: 'B',
    optional_text: 'keep',
  });
  await ok('/v1/contacts/' + contact.id, 'PUT', {
    customFields: { optional_date: null, optional_num: null, optional_select: null },
    email: contact.email,
    firstName: 'After',
  });
  let read = await ok<Contact>('/v1/contacts/' + contact.id);
  expect(read.customFields).toEqual({ optional_text: 'keep' });
  for (const key of ['optional_num', 'optional_date', 'optional_select']) {
    expect(await valueRow(key, contact.id), `${key} row should be deleted`).toBeNull();
  }

  // Omitting the whole object preserves everything.
  await ok('/v1/contacts/' + contact.id, 'PUT', { email: contact.email, firstName: 'Again' });
  read = await ok<Contact>('/v1/contacts/' + contact.id);
  expect(read.customFields).toEqual({ optional_text: 'keep' });

  await ok('/v1/contacts/' + contact.id, 'PUT', {
    customFields: { optional_text: null },
    email: contact.email,
  });
  read = await ok<Contact>('/v1/contacts/' + contact.id);
  expect(read.customFields).toEqual({});
});

test('archived values stay in storage, leave edit payloads, and do not block editing', async () => {
  const field = await createField('archive_me');
  const contact = await createContact('archive@example.test', {
    archive_me: 'historical',
    optional_text: 'active',
  });
  await api('/v1/custom-fields/' + field.id, 'DELETE');

  const read = await ok<Contact>('/v1/contacts/' + contact.id);
  expect(read.customFields).toEqual({ optional_text: 'active' });

  // The contact with an archived value remains editable.
  const edited = await ok<Contact>('/v1/contacts/' + contact.id, 'PUT', {
    customFields: read.customFields,
    email: contact.email,
    firstName: 'Edited',
  });
  expect(edited.customFields).toEqual({ optional_text: 'active' });

  // The archived value is retained for historical export.
  const stored = await valueRow('archive_me', contact.id);
  expect(stored?.value_text).toBe('historical');

  // Archived keys are rejected on writes.
  const rejected = await api('/v1/contacts/' + contact.id, 'PUT', {
    customFields: { archive_me: 'again' },
    email: contact.email,
  });
  expect(rejected.status).toBe(422);
});

test('an injected field write failure rolls back the whole create', async () => {
  await db
    .prepare(
      "CREATE TRIGGER regression_fail_insert BEFORE INSERT ON custom_field_values WHEN NEW.value_text = 'reject-value' BEGIN SELECT RAISE(ABORT, 'regression injected failure'); END",
    )
    .run();
  try {
    const made = await api('/v1/contacts', 'POST', {
      customFields: { optional_text: 'reject-value' },
      email: 'atomic-new@example.test',
      firstName: 'New',
    });
    expect(made.status).toBe(500);
    const contact = await db
      .prepare('SELECT id FROM contacts WHERE normalized_email = ?')
      .bind('atomic-new@example.test')
      .first();
    expect(contact, 'partial contact persisted').toBeNull();
    const value = await valueRow('optional_text', 'atomic-new@example.test');
    expect(value).toBeNull();
  } finally {
    await db.prepare('DROP TRIGGER regression_fail_insert').run();
  }
});

test('an injected field write failure leaves an existing contact untouched', async () => {
  const contact = await createContact('atomic-existing@example.test', {
    optional_text: 'original',
  });
  const before = await db
    .prepare('SELECT * FROM contacts WHERE id = ?')
    .bind(contact.id)
    .first();
  await db
    .prepare(
      "CREATE TRIGGER regression_fail_update BEFORE UPDATE ON custom_field_values WHEN NEW.value_text = 'reject-value' BEGIN SELECT RAISE(ABORT, 'regression injected failure'); END",
    )
    .run();
  try {
    const changed = await api('/v1/contacts/' + contact.id, 'PUT', {
      customFields: { optional_text: 'reject-value' },
      email: contact.email,
      firstName: 'Must rollback',
    });
    expect(changed.status).toBe(500);
    const after = await db
      .prepare('SELECT * FROM contacts WHERE id = ?')
      .bind(contact.id)
      .first();
    expect(after, 'base contact changed despite failed fields').toEqual(before);
    const read = await ok<Contact>('/v1/contacts/' + contact.id);
    expect(read.customFields).toEqual({ optional_text: 'original' });
  } finally {
    await db.prepare('DROP TRIGGER regression_fail_update').run();
  }
});

test('required fields reject null and cannot be bypassed on edit', async () => {
  // Created before the required field exists, so it has no stored value.
  const missing = await createContact('missing-required@example.test', {
    optional_text: 'legacy',
  });
  await createField('required_text', 'text', true);

  const badCreate = await api('/v1/contacts', 'POST', {
    customFields: { required_text: null },
    email: 'required-bad@example.test',
  });
  expect(badCreate.status).toBe(422);

  const bypassEmpty = await api('/v1/contacts/' + missing.id, 'PUT', {
    customFields: {},
    email: missing.email,
  });
  expect(bypassEmpty.status).toBe(422);
  const bypassOther = await api('/v1/contacts/' + missing.id, 'PUT', {
    customFields: { optional_text: 'other' },
    email: missing.email,
  });
  expect(bypassOther.status).toBe(422);

  const filled = await ok<Contact>('/v1/contacts/' + missing.id, 'PUT', {
    customFields: { optional_text: 'other', required_text: 'now' },
    email: missing.email,
  });
  expect(filled.customFields).toEqual({ optional_text: 'other', required_text: 'now' });

  const contact = await createContact('required@example.test', {
    optional_text: 'before',
    required_text: 'required',
  });
  const cleared = await api('/v1/contacts/' + contact.id, 'PUT', {
    customFields: { required_text: null },
    email: contact.email,
  });
  expect(cleared.status).toBe(422);

  // Omitting the required key preserves the stored value.
  await ok('/v1/contacts/' + contact.id, 'PUT', {
    customFields: { optional_text: 'after' },
    email: contact.email,
  });
  const read = await ok<Contact>('/v1/contacts/' + contact.id);
  expect(read.customFields).toEqual({ optional_text: 'after', required_text: 'required' });

  const unknown = await api('/v1/contacts/' + contact.id, 'PUT', {
    customFields: { unknown_key: 'bad' },
    email: contact.email,
  });
  expect(unknown.status).toBe(422);
});

test('intake rejects null for required fields and omits blank optional fields', async () => {
  await createField('required_text', 'text', true);
  const token = await ok<{ token: string }>('/v1/tokens', 'POST', { name: 'regression-intake' });
  const headers = { Authorization: `Bearer ${token.token}` };

  const bad = await api(
    '/v1/intakes',
    'POST',
    {
      contact: { customFields: { required_text: null }, email: 'intake-required@example.test' },
      opportunity: { name: 'Intake inquiry', source: 'calculator' },
      source: 'website_form',
    },
    { 'Idempotency-Key': 'regression-intake-bad', ...headers },
  );
  expect(bad.status).toBe(422);

  const good = await api(
    '/v1/intakes',
    'POST',
    {
      contact: {
        customFields: { optional_text: null, required_text: 'intake' },
        email: 'intake-optional@example.test',
      },
      opportunity: { name: 'Intake inquiry', source: 'calculator' },
      source: 'website_form',
    },
    { 'Idempotency-Key': 'regression-intake-good', ...headers },
  );
  expect(good.status).toBe(201);

  const contact = await db
    .prepare('SELECT id FROM contacts WHERE normalized_email = ?')
    .bind('intake-optional@example.test')
    .first();
  expect(contact).not.toBeNull();
  const contactId = (contact as { id: string }).id;
  expect(await valueRow('optional_text', contactId)).toBeNull();
});

test('manual opportunity creation rejects null for required contact fields', async () => {
  await createField('required_text', 'text', true);
  const bad = await api('/v1/opportunities', 'POST', {
    contact: { customFields: { required_text: null }, firstName: 'NoBypass' },
    name: 'Manual opportunity',
  });
  expect(bad.status).toBe(422);

  const good = await ok<Opportunity>('/v1/opportunities', 'POST', {
    contact: {
      customFields: { optional_text: null, required_text: 'manual' },
      firstName: 'OptionalBlank',
    },
    name: 'Manual opportunity',
  });
  expect(await valueRow('optional_text', good.contact.id)).toBeNull();
  const requiredStored = await valueRow('required_text', good.contact.id);
  expect(requiredStored?.value_text).toBe('manual');
});
