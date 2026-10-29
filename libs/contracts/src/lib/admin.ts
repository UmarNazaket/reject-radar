import type { SyncSource, SyncStatus } from './ingestion';
import type { SourceFreshness } from './notices';

/** Runs of each source listed by `GET /v1/admin/sources`. */
export const ADMIN_RECENT_RUNS = 10;

/** One sync run as `source_sync_run` records it. Times are ISO 8601. */
export interface SyncRunItem {
  id: number;
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Where the run read from, such as a file URL; null when the source has one place. */
  origin: string | null;
  partial: boolean;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  eventsEmitted: number;
  error: string | null;
}

/** A source's health: its freshness, when the product shows one, and its newest runs first. */
export interface AdminSourceItem {
  source: SyncSource;
  /** Null for a source the product does not show a date for (the FDA charge-code list). */
  freshness: SourceFreshness | null;
  runs: SyncRunItem[];
}

/** `GET /v1/admin/sources`: every source, in `SYNC_SOURCES` order. */
export interface AdminSourcesResponse {
  sources: AdminSourceItem[];
}
