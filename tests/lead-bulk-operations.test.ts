import {
  DEFAULT_WORKSPACE_ID,
  type Env,
  listLeads,
  softDeleteLeads,
} from '@/db/repository';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/**
 * Bulk lead operations must not bind one parameter per item: the originating
 * defect was D1's 100-bound-parameter cap, but the contract asserted here is
 * portable — a list's length must not change the number of parameters a
 * statement binds, and each operation must stay one statement. The fixture runs
 * the real D1 binding through Miniflare, and the wrapper records how bindings
 * and statements scale so a per-item binding regression fails here.
 */

const repoRoot = process.cwd();
const WORKSPACE = DEFAULT_WORKSPACE_ID;

type BindingGuard = {
  maxBindings: number;
  statements: string[];
};

const watchBindings = (
  binding: D1Database,
): { db: D1Database; guard: BindingGuard } => {
  const guard: BindingGuard = { maxBindings: 0, statements: [] };
  const rawStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

  const wrapStatement = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property, receiver) {
        if (property === 'bind') {
          return (...parameters: unknown[]) => {
            guard.maxBindings = Math.max(guard.maxBindings, parameters.length);
            return wrapStatement(target.bind(...parameters), sql);
          };
        }

        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    return wrapped;
  };

  const database = new Proxy(binding, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          guard.statements.push(sql);
          return wrapStatement(target.prepare(sql), sql);
        };
      }

      if (property === 'batch') {
        return (statements: D1PreparedStatement[]) =>
          target.batch(
            statements.map(
              (statement) => rawStatements.get(statement) ?? statement,
            ),
          );
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { db: database, guard };
};

type LimitsFixture = {
  db: D1Database;
  dispose: () => Promise<void>;
  env: Env;
  guard: BindingGuard;
};

const startFixture = async (): Promise<LimitsFixture> => {
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

    const { db, guard } = watchBindings(raw);
    return {
      db,
      dispose,
      env: { DB: db } as unknown as Env,
      guard,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

const resetGuard = (guard: BindingGuard): void => {
  guard.maxBindings = 0;
  guard.statements.length = 0;
};

const makeIds = (prefix: string, count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(4, '0')}`,
  );

const insertLeads = async (
  database: D1Database,
  leads: Array<{ createdAt?: number; email?: null | string; id: string }>,
): Promise<void> => {
  const createdAt = Date.now();
  const statements = leads.map((lead) =>
    database
      .prepare(
        `INSERT INTO leads (
          id, workspace_id, email, first_name, last_name,
          source, estimated_value, custom_fields,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', ?, ?, NULL)`,
      )
      .bind(
        lead.id,
        WORKSPACE,
        lead.email ?? null,
        'Test',
        'Lead',
        'website',
        lead.createdAt ?? createdAt,
        lead.createdAt ?? createdAt,
      ),
  );
  for (let index = 0; index < statements.length; index += 100) {
    await database.batch(statements.slice(index, index + 100));
  }
};

test('bulk soft delete binds the same parameters for any list length', async () => {
  const fx = await startFixture();
  try {
    const single = makeIds('01ARZ3NDEKTSV4RRFFQ69G5FA', 1);
    await insertLeads(
      fx.db,
      single.map((id) => ({ id })),
    );
    resetGuard(fx.guard);
    expect(await softDeleteLeads(fx.env, single)).toBe(1);
    const singleBindings = fx.guard.maxBindings;
    const singleUpdateStatements = fx.guard.statements.filter((sql) =>
      /^UPDATE/iu.test(sql.trim()),
    ).length;

    // 500 exceeds even the API's 100-id validation; the point is that the
    // statement does not grow with the list.
    const bulk = makeIds('01ARZ3NDEKTSV4RRFFQ69G5FB', 500);
    await insertLeads(
      fx.db,
      bulk.map((id) => ({ id })),
    );
    resetGuard(fx.guard);
    expect(await softDeleteLeads(fx.env, bulk)).toBe(500);
    const bulkBindings = fx.guard.maxBindings;
    const bulkUpdateStatements = fx.guard.statements.filter((sql) =>
      /^UPDATE/iu.test(sql.trim()),
    ).length;

    expect(singleUpdateStatements).toBe(1);
    expect(bulkUpdateStatements).toBe(1);
    expect(bulkBindings).toBe(singleBindings);
  } finally {
    await fx.dispose();
  }
});

test('bulk soft delete deduplicates ids before binding', async () => {
  const fx = await startFixture();
  try {
    const ids = makeIds('01ARZ3NDEKTSV4RRFFQ69G5FE', 100);
    await insertLeads(
      fx.db,
      ids.map((id) => ({ id })),
    );

    resetGuard(fx.guard);
    const deleted = await softDeleteLeads(fx.env, [...ids, ...ids]);
    expect(deleted).toBe(100);
    expect(
      fx.guard.statements.filter((sql) => /^UPDATE/iu.test(sql.trim())),
    ).toHaveLength(1);
  } finally {
    await fx.dispose();
  }
});

test('duplicate hints come from the page query without list bindings', async () => {
  const fx = await startFixture();
  try {
    const base = Date.now();
    const ids = makeIds('01ARZ3NDEKTSV4RRFFQ69G5FC', 100);
    await insertLeads(fx.db, [
      ...ids.map((id, index) => ({
        createdAt: base - index,
        email: `page-${index}@example.test`,
        id,
      })),
      {
        createdAt: base - 1_000,
        email: 'page-99@example.test',
        id: '01ARZ3NDEKTSV4RRFFQ69G5FD0000',
      },
    ]);

    resetGuard(fx.guard);
    const singlePage = await listLeads(fx.env, { limit: 1 });
    const singleBindings = fx.guard.maxBindings;
    const singleStatements = fx.guard.statements.filter((sql) =>
      /^SELECT/iu.test(sql.trim()),
    ).length;

    resetGuard(fx.guard);
    const fullPage = await listLeads(fx.env, { limit: 100 });
    const fullBindings = fx.guard.maxBindings;
    const fullStatements = fx.guard.statements.filter((sql) =>
      /^SELECT/iu.test(sql.trim()),
    ).length;

    expect(fullPage.leads).toHaveLength(100);
    // The hint includes the live duplicate that sits beyond the page.
    for (const lead of fullPage.leads) {
      expect(lead.duplicateCount, String(lead.email)).toBe(
        lead.email === 'page-99@example.test' ? 1 : 0,
      );
    }

    expect(singlePage.leads).toHaveLength(1);

    expect(singleStatements).toBe(1);
    expect(fullStatements).toBe(1);
    expect(fullBindings).toBe(singleBindings);
  } finally {
    await fx.dispose();
  }
});
