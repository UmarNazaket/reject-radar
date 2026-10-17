import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/** Spec §5.4: a small pool that releases idle connections fast so Neon can scale to zero. */
export const POOL_DEFAULTS = {
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 30_000, // allows for a Neon cold start
} as const satisfies PoolConfig;

export type PoolErrorHandler = (error: Error) => void;

/** Default: report and keep running; the pool replaces the dead client on the next query. */
const logPoolError: PoolErrorHandler = (error) => {
  console.error(`Postgres pool: idle client error: ${error.message}`);
};

export function createPool(connectionString: string, overrides: PoolConfig = {}, onError: PoolErrorHandler = logPoolError): Pool {
  const pool = new Pool({ connectionString, ...POOL_DEFAULTS, ...overrides });
  // An 'error' event with no listener would crash the process (spec §5.4: Neon closes idle connections).
  pool.on('error', onError);
  return pool;
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}
