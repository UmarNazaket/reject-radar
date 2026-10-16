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

export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  return new Pool({ connectionString, ...POOL_DEFAULTS, ...overrides });
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}
