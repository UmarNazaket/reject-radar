import type { SyncSource } from '@rejectradar/contracts';
import { sourceSyncRun, type Database } from '@rejectradar/db';

/**
 * Records an earlier succeeded run of `source`, so the next sync is not a first load and emits events as asked
 * (see `eventsForRun`); only for use in specs.
 */
export async function seedSucceededRun(db: Database, source: SyncSource): Promise<void> {
  await db.insert(sourceSyncRun).values({ source, status: 'succeeded', finishedAt: new Date() });
}
