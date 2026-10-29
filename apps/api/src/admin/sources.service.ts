import { Inject, Injectable } from '@nestjs/common';
import { ADMIN_RECENT_RUNS, type AdminSourcesResponse, SYNC_SOURCES, type SyncRunItem, type SyncSource, type SyncStatus } from '@rejectradar/contracts';
import type { Database } from '@rejectradar/db';
import { sql } from 'drizzle-orm';
import { DB } from '../database/database.module';
import { FreshnessService } from '../notices/freshness.service';

type RunRow = {
  id: number;
  source: SyncSource;
  status: SyncStatus;
  started_at: Date | string;
  finished_at: Date | string | null;
  origin: string | null;
  partial: boolean;
  rows_read: number;
  rows_inserted: number;
  rows_updated: number;
  rows_deleted: number;
  events_emitted: number;
  error: string | null;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

/** Source health for staff: the freshness customers see, plus each source's newest runs with their counts and errors. */
@Injectable()
export class SourcesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly freshness: FreshnessService,
  ) {}

  async all(): Promise<AdminSourcesResponse> {
    const [freshness, runs] = await Promise.all([
      this.freshness.all(),
      this.db.execute<RunRow>(sql`
        select id, source, status, started_at, finished_at, origin, partial, rows_read, rows_inserted, rows_updated, rows_deleted, events_emitted, error
        from (select *, row_number() over (partition by source order by started_at desc, id desc) as n from source_sync_run) runs
        where n <= ${ADMIN_RECENT_RUNS}
        order by started_at desc, id desc`),
    ]);
    return {
      sources: SYNC_SOURCES.map((source) => ({
        source,
        freshness: freshness.find((f) => f.source === source) ?? null,
        runs: runs.rows.filter((run) => run.source === source).map(toRunItem),
      })),
    };
  }
}

function toRunItem(row: RunRow): SyncRunItem {
  return {
    id: Number(row.id),
    status: row.status,
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at === null ? null : iso(row.finished_at),
    origin: row.origin,
    partial: row.partial,
    rowsRead: row.rows_read,
    rowsInserted: row.rows_inserted,
    rowsUpdated: row.rows_updated,
    rowsDeleted: row.rows_deleted,
    eventsEmitted: row.events_emitted,
    error: row.error,
  };
}
