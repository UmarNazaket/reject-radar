import { Client } from 'pg';
import { runMigrations } from './migrate';

const SAFE_SUFFIX = /^[a-z0-9_]+$/;

export function testServerUrl(): string {
  return (process.env['TEST_DATABASE_SERVER_URL'] ?? 'postgres://rejectradar:rejectradar@localhost:5432').replace(/\/+$/, '');
}

export function testDatabaseUrl(suffix: string): string {
  if (!SAFE_SUFFIX.test(suffix)) throw new Error(`Invalid test database suffix "${suffix}"`);
  return `${testServerUrl()}/rejectradar_test_${suffix}`;
}

/**
 * Creates `rejectradar_test_<suffix>` if needed, wipes it and applies every migration.
 * Each Nx project uses its own suffix, so parallel test runs never share a database.
 */
export async function prepareTestDatabase(suffix: string): Promise<string> {
  const url = testDatabaseUrl(suffix);
  const dbName = `rejectradar_test_${suffix}`;

  const admin = new Client({ connectionString: `${testServerUrl()}/postgres` });
  await admin.connect();
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
    if (existing.rowCount === 0) await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema if exists drizzle cascade');
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
  } finally {
    await client.end();
  }

  await runMigrations(url);
  return url;
}
