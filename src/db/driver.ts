import * as schema from './schema';
import { drizzle } from 'drizzle-orm/d1';

/**
 * Database port.
 *
 * Application modules import database access from here and never name the
 * runtime binding or its driver. This file is the only place the Cloudflare D1
 * binding type and `drizzle-orm/d1` appear, so plugging in another engine means
 * replacing the adapter below while keeping the same exports:
 *
 * - `createClient(binding)` returns a Drizzle client for ./schema
 * - `prepare(binding, sql)` returns a bindable statement
 * - `executeAtomically(binding, statements)` runs one all-or-nothing batch
 * - `Database`, `Client`, and `Statement` are derived from the adapter, so
 *   callers never import an engine type directly
 *
 * A second adapter would split this into driver/index.ts (chooses) and
 * driver/<engine>.ts (implements); one adapter does not need the directory yet.
 * The ESLint config forbids importing `drizzle-orm/d1` or naming the D1 binding
 * types outside this file.
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
