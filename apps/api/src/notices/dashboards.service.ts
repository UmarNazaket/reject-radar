import { Inject, Injectable } from '@nestjs/common';
import {
  DESTINATIONS,
  type DashboardQuery,
  type DashboardResponse,
  type DestinationCounts,
  type HazardCategoryId,
} from '@rejectradar/contracts';
import { commodityWithin, type Database, notice } from '@rejectradar/db';
import { and, desc, type SQL, sql } from 'drizzle-orm';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { FreshnessService } from './freshness.service';
import { NOTICE_COLUMNS, TODAY, toNoticeItem } from './notices.service';

const MAX_MONTHS = 36;

/** One column per destination (`"US"`, `"EU"`, `"UK"`, `"AU"`), each counting the rows of `rows` that go there. */
const perDestination = (rows: SQL): SQL =>
  sql.join(
    DESTINATIONS.map((destination) => sql`(count(${rows}) filter (where base.destination = ${destination}))::int as ${sql.raw(`"${destination}"`)}`),
    sql`, `,
  );

type CountsRow = { US: number; EU: number; UK: number; AU: number };
const toCounts = (row: CountsRow): DestinationCounts => ({ US: row.US, EU: row.EU, UK: row.UK, AU: row.AU });

/**
 * The topic dashboard (spec §7.3, P5-D7). A topic is an origin, optionally narrowed by a commodity (with its
 * descendants, P5-D6) and by destinations. Every block reads the same filtered set of `notice` rows, inside the
 * account's history window, and the blocks run side by side. Notices are reference data, the same for every account.
 */
@Injectable()
export class DashboardsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
    private readonly freshness: FreshnessService,
  ) {}

  async topic(orgId: string, query: DashboardQuery): Promise<DashboardResponse> {
    const [{ limits }, historyFrom] = await Promise.all([this.entitlements.resolvePlan(orgId), this.entitlements.historyFrom(orgId)]);
    const monthCount = Math.min(MAX_MONTHS, limits.noticeHistoryMonths ?? MAX_MONTHS);
    // The first day of the oldest month shown, and the start of the 12-month blocks; neither goes past the history window.
    const monthsStart = sql`(date_trunc('month', ${TODAY}) - make_interval(months => ${monthCount - 1}))::date`;
    const since12 = sql`greatest((${TODAY} - interval '12 months')::date, ${historyFrom}::date)`;
    const sinceMonths = sql`greatest(${monthsStart}, ${historyFrom}::date)`;

    const destinations = query.destination?.map((destination) => sql`${destination}`);
    /** The topic's rows from `since` on: the CTE every block starts from. */
    const base = (since: SQL): SQL => {
      const conditions: SQL[] = [sql`origin_country = ${query.origin}`, sql`notice_on >= ${since}`];
      if (query.commodity !== undefined) conditions.push(commodityWithin(sql`commodity_id`, query.commodity));
      if (destinations) conditions.push(sql`destination in (${sql.join(destinations, sql`, `)})`);
      return sql`with base as (select id, notice_on, destination, commodity_id, hazard_ids from notice where ${sql.join(conditions, sql` and `)})`;
    };

    const [months, totals, categories, findings, commodities, latest, freshness] = await Promise.all([
      this.db.execute<{ month: string } & CountsRow>(sql`
        ${base(sinceMonths)},
        series as (select generate_series(${monthsStart}, date_trunc('month', ${TODAY})::date, interval '1 month')::date as month_start)
        select to_char(series.month_start, 'YYYY-MM') as month, ${perDestination(sql`base.id`)}
        from series left join base on date_trunc('month', base.notice_on) = series.month_start
        group by series.month_start order by series.month_start`),
      this.db.execute<CountsRow>(sql`${base(since12)} select ${perDestination(sql`base.id`)} from base`),
      this.db.execute<{ category: HazardCategoryId; count: number }>(sql`
        ${base(since12)}
        select hazard.category, count(distinct base.id)::int as count
        from base cross join lateral unnest(base.hazard_ids) as hazard_id
        join hazard on hazard.id = hazard_id
        group by hazard.category order by count desc, hazard.category limit 6`),
      this.db.execute<{ hazardId: number; count: number } & CountsRow>(sql`
        ${base(since12)}
        select hazard_id as "hazardId", count(distinct base.id)::int as count, ${perDestination(sql`distinct base.id`)}
        from base cross join lateral unnest(base.hazard_ids) as hazard_id
        group by hazard_id order by count desc, hazard_id limit 10`),
      this.db.execute<{ commodityId: number; count: number }>(sql`
        ${base(since12)}
        select commodity_id as "commodityId", count(*)::int as count
        from base where commodity_id is not null
        group by commodity_id order by count desc, commodity_id limit 6`),
      this.latest(query, historyFrom),
      this.freshness.all(),
    ]);

    return {
      months: months.rows.map((row) => ({ month: row.month, ...toCounts(row) })),
      totals12m: toCounts(totals.rows[0]),
      hazardCategories: categories.rows.map((row) => ({ category: row.category, count: row.count })),
      findings: findings.rows.map((row) => ({ hazardId: row.hazardId, count: row.count, byDestination: toCounts(row) })),
      commodities: commodities.rows.map((row) => ({ commodityId: row.commodityId, count: row.count })),
      latest,
      historyFrom,
      freshness,
    };
  }

  /** The 20 newest notices of the topic inside the history window. */
  private async latest(query: DashboardQuery, historyFrom: string | null) {
    const conditions: SQL[] = [sql`${notice.originCountry} = ${query.origin}`];
    if (historyFrom) conditions.push(sql`${notice.noticeOn} >= ${historyFrom}`);
    if (query.commodity !== undefined) conditions.push(commodityWithin(notice.commodityId, query.commodity));
    if (query.destination) {
      conditions.push(sql`${notice.destination} in (${sql.join(query.destination.map((destination) => sql`${destination}`), sql`, `)})`);
    }
    const rows = await this.db
      .select(NOTICE_COLUMNS)
      .from(notice)
      .where(and(...conditions))
      .orderBy(desc(notice.noticeOn), desc(notice.id))
      .limit(20);
    return rows.map(toNoticeItem);
  }
}
