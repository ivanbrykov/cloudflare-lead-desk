import { DEFAULT_WORKSPACE_ID, type Env, listLeads } from '@/db/repository';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Lead search must not depend on LIKE or GLOB: D1 caps their patterns at 50
 * bytes, which ordinary search strings can exceed, and their escaping is easy
 * to get wrong. The fixture records every prepared statement and the search
 * path fails if either construct appears, regardless of pattern length.
 * https://developers.cloudflare.com/d1/platform/limits/
 */

const repoRoot = process.cwd();
const WORKSPACE = DEFAULT_WORKSPACE_ID;

const watchStatements = (
  binding: D1Database,
): { db: D1Database; statements: string[] } => {
  const statements: string[] = [];
  const database = new Proxy(binding, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { db: database, statements };
};

type SearchFixture = {
  db: D1Database;
  dispose: () => Promise<void>;
  env: Env;
  statements: string[];
};

const startFixture = async (): Promise<SearchFixture> => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-08-22',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      modules: true,
      script: 'export default {};',
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
    const raw = await mf.getD1Database('DB');
    const names = (await readdir(join(repoRoot, 'drizzle')))
      .filter((name) => name.endsWith('.sql'))
      .toSorted();
    for (const name of names) {
      const sql = await readFile(join(repoRoot, 'drizzle', name), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((chunk) => chunk.trim())
        .filter(Boolean)) {
        await raw.prepare(statement).run();
      }
    }

    const { db, statements } = watchStatements(raw);
    return {
      db,
      dispose,
      env: { DB: db } as unknown as Env,
      statements,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

let nextId = 0;
const insertLead = async (
  database: D1Database,
  lead: {
    email?: null | string;
    firstName?: null | string;
    id?: string;
    lastName?: null | string;
  },
): Promise<string> => {
  nextId += 1;
  const id =
    lead.id ?? `01ARZ3NDEKTSV4RRFFQ69G5${String(nextId).padStart(4, '0')}`;
  const createdAt = Date.now() - nextId;
  await database
    .prepare(
      `INSERT INTO leads (
        id, workspace_id, email, first_name, last_name,
        source, estimated_value, custom_fields,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?, NULL)`,
    )
    .bind(
      id,
      WORKSPACE,
      lead.email ?? null,
      lead.firstName ?? null,
      lead.lastName ?? null,
      'website',
      createdAt,
      createdAt,
    )
    .run();
  return id;
};

const search = async (fx: SearchFixture, query: string) =>
  listLeads(fx.env, { limit: 10, query });

const expectNoLikeOrGlob = (fx: SearchFixture): void => {
  expect(
    fx.statements.filter((sql) => /\b(?:LIKE|GLOB)\b/iu.test(sql)),
  ).toEqual([]);
};

test('search matches queries longer than the old LIKE pattern cap', async () => {
  const fx = await startFixture();
  try {
    const longNeedle = 'x'.repeat(60);
    await insertLead(fx.db, {
      firstName: `prefix ${longNeedle} suffix`,
    });
    await insertLead(fx.db, { firstName: 'unrelated' });

    fx.statements.length = 0;
    const page = await search(fx, longNeedle);
    expect(page.leads).toHaveLength(1);
    expect(page.leads[0]?.firstName).toContain(longNeedle);
    expectNoLikeOrGlob(fx);
  } finally {
    await fx.dispose();
  }
});

test('search treats backslashes and wildcards literally', async () => {
  const fx = await startFixture();
  try {
    const backslashId = await insertLead(fx.db, { firstName: 'back\\slash' });
    const plainId = await insertLead(fx.db, { firstName: 'backslash' });
    const wildcardId = await insertLead(fx.db, { firstName: '50%_off' });
    const trailingId = await insertLead(fx.db, { lastName: 'trailing\\' });

    fx.statements.length = 0;
    const backslash = await search(fx, 'back\\slash');
    expect(backslash.leads.map((lead) => lead.id)).toEqual([backslashId]);

    const plain = await search(fx, 'backslash');
    expect(plain.leads.map((lead) => lead.id)).toEqual([plainId]);

    const wildcard = await search(fx, '50%_off');
    expect(wildcard.leads.map((lead) => lead.id)).toEqual([wildcardId]);

    const trailing = await search(fx, 'trailing\\');
    expect(trailing.leads.map((lead) => lead.id)).toEqual([trailingId]);
    expectNoLikeOrGlob(fx);
  } finally {
    await fx.dispose();
  }
});

test('search stays case-insensitive for ASCII and exact for other bytes', async () => {
  const fx = await startFixture();
  try {
    const id = await insertLead(fx.db, { firstName: 'Acme Corp' });
    const unicodeId = await insertLead(fx.db, { firstName: 'Ünïcode' });

    fx.statements.length = 0;
    expect((await search(fx, 'ACME')).leads.map((lead) => lead.id)).toEqual([
      id,
    ]);
    expect(
      (await search(fx, 'acme corp')).leads.map((lead) => lead.id),
    ).toEqual([id]);
    expect((await search(fx, 'Ünïcode')).leads.map((lead) => lead.id)).toEqual([
      unicodeId,
    ]);
    expectNoLikeOrGlob(fx);
  } finally {
    await fx.dispose();
  }
});
