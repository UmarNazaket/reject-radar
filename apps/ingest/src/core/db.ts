import { createDb, createPool, type Database } from '@rejectradar/db';

/** One pool and drizzle handle for a CLI command; call `close()` so the process can exit. */
export function openDb(url: string): { db: Database; close(): Promise<void> } {
  const pool = createPool(url);
  return { db: createDb(pool), close: () => pool.end() };
}
