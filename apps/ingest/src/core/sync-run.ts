import type { SyncSource } from '@rejectradar/contracts';
import { sourceSyncRun, type Database } from '@rejectradar/db';
import { and, desc, eq } from 'drizzle-orm';
import { databaseSizeBytes, SIZE_LIMIT_BYTES, SizeLimitError } from './size-check';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface SyncCounts {
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  eventsEmitted: number;
}

export interface SyncContext {
  runId: number;
  counts: SyncCounts;
  /** Records where the data came from (and its SHA-256, when there is one single file). */
  setOrigin(origin: string, sha256?: string): void;
}

export interface SyncRunResult extends SyncCounts {
  runId: number;
  status: 'succeeded';
}

const MAX_ERROR_LENGTH = 2000;

const errorText = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, MAX_ERROR_LENGTH);

/**
 * Runs one sync (spec §6.3): size check, a `source_sync_run` row, the work, then the final status.
 * The work does its live-table writes in one transaction of its own, so a failure leaves them unchanged.
 */
export async function runSync(
  db: Database,
  source: SyncSource,
  work: (ctx: SyncContext) => Promise<void>,
  options: { sizeLimitBytes?: number } = {},
): Promise<SyncRunResult> {
  const limit = options.sizeLimitBytes ?? SIZE_LIMIT_BYTES;
  const [run] = await db.insert(sourceSyncRun).values({ source, status: 'running' }).returning({ id: sourceSyncRun.id });
  const counts: SyncCounts = { rowsRead: 0, rowsInserted: 0, rowsUpdated: 0, rowsDeleted: 0, eventsEmitted: 0 };
  let origin: string | null = null;
  let contentSha256: string | null = null;

  try {
    const size = await databaseSizeBytes(db);
    if (size >= limit) throw new SizeLimitError(size, limit);
    await work({
      runId: run.id,
      counts,
      setOrigin(value, sha256) {
        origin = value;
        contentSha256 = sha256 ?? null;
      },
    });
    await db
      .update(sourceSyncRun)
      .set({ status: 'succeeded', finishedAt: new Date(), origin, contentSha256, ...counts })
      .where(eq(sourceSyncRun.id, run.id));
    return { runId: run.id, status: 'succeeded', ...counts };
  } catch (error) {
    try {
      await db
        .update(sourceSyncRun)
        .set({ status: 'failed', finishedAt: new Date(), origin, contentSha256, ...counts, error: errorText(error) })
        .where(eq(sourceSyncRun.id, run.id));
    } catch {
      // The original failure matters more than a failure to record it.
    }
    throw error;
  }
}

export async function lastSucceededRun(db: Database, source: SyncSource): Promise<{ id: number; startedAt: Date } | null> {
  const [row] = await db
    .select({ id: sourceSyncRun.id, startedAt: sourceSyncRun.startedAt })
    .from(sourceSyncRun)
    .where(and(eq(sourceSyncRun.source, source), eq(sourceSyncRun.status, 'succeeded')))
    .orderBy(desc(sourceSyncRun.startedAt), desc(sourceSyncRun.id))
    .limit(1);
  return row ?? null;
}

/**
 * Whether this run may emit change events (P2-D6). A source with no succeeded run yet is on its first load, which would
 * otherwise emit one event per stored record (thousands for most sources), so its events are suppressed with a warning,
 * even when `--no-events` was forgotten or a schedule fires before the manual backfill.
 */
export async function eventsForRun(db: Database, source: SyncSource, requested: boolean): Promise<boolean> {
  if (!requested) return false;
  if ((await lastSucceededRun(db, source)) !== null) return true;
  console.warn(`first load of ${source}: events suppressed`);
  return false;
}
