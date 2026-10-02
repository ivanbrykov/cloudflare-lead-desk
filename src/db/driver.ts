import * as schema from './schema';
import { drizzle } from 'drizzle-orm/d1';

/**
 * Database port.
 *
 * Application modules import database access from here rather than from the
 * engine: this file is the only place that imports `drizzle-orm/d1` or names
 * the Cloudflare D1 binding, and ESLint enforces that boundary for `src/`.
 *
 * - `createClient(binding)` returns a Drizzle client for ./schema
 * - `prepare(binding, sql)` returns a bindable statement
 * - `executeAtomically(binding, statements)` runs one all-or-nothing batch
 * - `Database`, `Client`, and `Statement` are derived from the adapter below
 *
 * Scope: this centralizes engine imports and binding access; it does not erase
 * D1-shaped results (`result.meta.changes`, `binding.batch()`) from callers.
 * Moving engines still means a new adapter here, an `Env` binding change, and
 * migrations — but not edits across the repositories.
 *
 * A second adapter would split this into driver/index.ts (chooses) and
 * driver/<engine>.ts (implements); one adapter does not need the directory yet.
 */
const createD1Client = (binding: D1Database) => drizzle(binding, { schema });

export type Client = ReturnType<typeof createD1Client>;
export type Database = Parameters<typeof createD1Client>[0];
export type Statement = ReturnType<Database['prepare']>;

export const createClient = createD1Client;

export const prepare = (database: Database, sql: string): Statement =>
  database.prepare(sql);

export const executeAtomically = async (
  database: Database,
  statements: Statement[],
): Promise<void> => {
  await database.batch(statements);
};
