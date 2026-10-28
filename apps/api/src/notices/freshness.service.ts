import { Inject, Injectable } from '@nestjs/common';
import { FRESHNESS_SOURCES, type FreshnessSource, type SourceFreshness, STALE_AFTER_DAYS } from '@rejectradar/contracts';
import { auFailingFood, type Database, sourceSyncRun, ukBorderNotification } from '@rejectradar/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB } from '../database/database.module';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How current each source is (spec §6.6): the latest complete, successful sync, and whether that is older than the
 * source's `STALE_AFTER_DAYS`. A run limited to part of a source (`partial`) never counts.
 */
@Injectable()
export class FreshnessService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** One entry per source, in `FRESHNESS_SOURCES` order. */
  async all(): Promise<SourceFreshness[]> {
    const [runs, uk, au] = await Promise.all([
      this.db
        .select({ source: sourceSyncRun.source, at: sql<Date | null>`max(coalesce(${sourceSyncRun.finishedAt}, ${sourceSyncRun.startedAt}))` })
        .from(sourceSyncRun)
        .where(
          and(eq(sourceSyncRun.status, 'succeeded'), eq(sourceSyncRun.partial, false), inArray(sourceSyncRun.source, [...FRESHNESS_SOURCES])),
        )
        .groupBy(sourceSyncRun.source),
      this.db.select({ month: sql<string | null>`to_char(max(${ukBorderNotification.notifiedOn}), 'YYYY-MM')` }).from(ukBorderNotification),
      this.db.select({ month: sql<string | null>`to_char(max(${auFailingFood.reportMonth}), 'YYYY-MM')` }).from(auFailingFood),
    ]);
    const lastSuccess = new Map(runs.map((run) => [run.source, run.at === null ? null : new Date(run.at)]));
    const latestMonth: Partial<Record<FreshnessSource, string | null>> = { uk_bn: uk[0]?.month ?? null, au_ifis: au[0]?.month ?? null };
    const now = Date.now();
    return FRESHNESS_SOURCES.map((source) => {
      const last = lastSuccess.get(source) ?? null;
      return {
        source,
        lastSuccessAt: last === null ? null : last.toISOString(),
        stale: last === null || now - last.getTime() > STALE_AFTER_DAYS[source] * DAY_MS,
        latestMonth: latestMonth[source] ?? null,
      };
    });
  }
}
