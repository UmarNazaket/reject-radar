import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool } from './client';

/** Source-relative path; used by tests. Deployments run `drizzle-kit migrate` instead (spec §17). */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../migrations');

export async function runMigrations(connectionString: string, migrationsFolder = MIGRATIONS_FOLDER): Promise<void> {
  const pool = createPool(connectionString, { max: 1 });
  try {
    await migrate(createDb(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
