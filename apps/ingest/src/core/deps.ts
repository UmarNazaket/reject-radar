import type { IngestEnv } from '@rejectradar/contracts';
import type { Database } from '@rejectradar/db';
import type { RuleSet } from '@rejectradar/taxonomy';
import { openDb } from './db';
import { createFetcher, type Fetcher } from './http';
import { loadRuleSet } from './rules';

/** Everything a data sync needs from its surroundings; tests pass fakes. */
export interface SyncDeps {
  db: Database;
  fetcher: Fetcher;
  rules: RuleSet;
  /** Today's date in UTC as `YYYY-MM-DD`. */
  today: () => string;
}

export const utcToday = (): string => new Date().toISOString().slice(0, 10);

/** Opens the database, builds the polite fetcher and loads the rules. `close()` ends the connection pool. */
export async function createDeps(env: IngestEnv): Promise<SyncDeps & { close(): Promise<void> }> {
  const { db, close } = openDb(env.DATABASE_URL);
  try {
    const rules = await loadRuleSet(db);
    return { db, fetcher: createFetcher({ contact: env.INGEST_CONTACT_EMAIL }), rules, today: utcToday, close };
  } catch (error) {
    await close();
    throw error;
  }
}
