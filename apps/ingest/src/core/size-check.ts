import type { Database } from '@rejectradar/db';
import { sql } from 'drizzle-orm';

/** Spec §6.3: every sync aborts at or above 900 MB so the database stays inside the hosting plan. */
export const SIZE_LIMIT_BYTES = 900 * 1024 * 1024;

const MB = 1024 * 1024;

export const toMegabytes = (bytes: number): number => Math.round((bytes / MB) * 10) / 10;

export class SizeLimitError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Database size ${toMegabytes(sizeBytes)} MB is at or above the ${toMegabytes(limitBytes)} MB limit; sync aborted`);
    this.name = 'SizeLimitError';
  }
}

export async function databaseSizeBytes(db: Database): Promise<number> {
  const result = await db.execute<{ size: string }>(sql`select pg_database_size(current_database())::bigint as size`);
  return Number(result.rows[0].size);
}
