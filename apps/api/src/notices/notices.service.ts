import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { NoticeItem, NoticeSearchQuery, NoticeSearchResponse, NoticeSource, NoticeType, TopicFields, Destination } from '@rejectradar/contracts';
import { commodityWithin, type Database, hazard, notice, topicFilter } from '@rejectradar/db';
import { and, desc, eq, gte, inArray, isNotNull, lte, type SQL, sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { escapeLike } from '../common/like';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';

const DAY_MS = 24 * 60 * 60 * 1000;

const COLUMNS = {
  id: notice.id,
  source: notice.source,
  noticeType: notice.noticeType,
  destination: notice.destination,
  noticeOn: notice.noticeOn,
  originCountry: notice.originCountry,
  commodityId: notice.commodityId,
  hazardIds: notice.hazardIds,
  productText: notice.productText,
  firmName: notice.firmName,
  firmId: notice.firmId,
  title: notice.title,
  url: notice.url,
};

function toItem(row: Omit<typeof notice.$inferSelect, 'sourceKey'>): NoticeItem {
  return {
    id: row.id,
    source: row.source as NoticeSource,
    noticeType: row.noticeType as NoticeType,
    destination: row.destination as Destination,
    noticeOn: row.noticeOn,
    originCountry: row.originCountry,
    commodityId: row.commodityId,
    hazardIds: row.hazardIds,
    productText: row.productText,
    firmName: row.firmName,
    firmId: row.firmId,
    title: row.title,
    url: row.url,
  };
}

/** The later of two `YYYY-MM-DD` dates; a null date reaches back as far as it can. */
const laterOf = (a: string | null | undefined, b: string | null | undefined): string | null => {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
};

/**
 * The unified notices (spec §7.3): search with keyset paging, one notice, and counts for watched topics. Notices are
 * reference data, the same for every account, except for how far back the account's plan reaches (`historyFrom`).
 */
@Injectable()
export class NoticesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** One page, newest first (`notice_on desc, id desc`), within the account's history window. */
  async search(orgId: string, query: NoticeSearchQuery, pageSize = 50): Promise<NoticeSearchResponse> {
    const historyFrom = await this.entitlements.historyFrom(orgId);
    const conditions: (SQL | undefined)[] = [];
    if (query.destination) conditions.push(inArray(notice.destination, query.destination));
    if (query.source) conditions.push(inArray(notice.source, query.source));
    if (query.origin) conditions.push(eq(notice.originCountry, query.origin));
    if (query.commodity !== undefined) conditions.push(commodityWithin(notice.commodityId, query.commodity));
    if (query.hazard !== undefined) conditions.push(sql`${query.hazard} = any(${notice.hazardIds})`);
    if (query.hazardCategory) {
      conditions.push(
        sql`exists (select 1 from ${hazard} where ${hazard.id} = any(${notice.hazardIds}) and ${hazard.category} = ${query.hazardCategory})`,
      );
    }
    const from = laterOf(query.from, historyFrom);
    if (from) conditions.push(gte(notice.noticeOn, from));
    if (query.to) conditions.push(lte(notice.noticeOn, query.to));
    if (query.q) conditions.push(sql`${notice.productText} ilike '%' || ${escapeLike(query.q)} || '%'`);
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      conditions.push(sql`(${notice.noticeOn}, ${notice.id}) < (${cursor.date}::date, ${cursor.id}::bigint)`);
    }

    // One row more than the page tells whether another page follows.
    const rows = await this.db
      .select(COLUMNS)
      .from(notice)
      .where(and(...conditions))
      .orderBy(desc(notice.noticeOn), desc(notice.id))
      .limit(pageSize + 1);
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      items: page.map(toItem),
      next: rows.length > pageSize && last ? encodeCursor(last.noticeOn, last.id) : null,
      historyFrom,
    };
  }

  /** One notice. `404` when there is none; `403 PLAN_UPGRADE_REQUIRED` when it is older than the account's plan reaches. */
  async get(orgId: string, id: number): Promise<NoticeItem> {
    const [row] = await this.db.select(COLUMNS).from(notice).where(eq(notice.id, id));
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Notice not found.');
    const historyFrom = await this.entitlements.historyFrom(orgId);
    if (historyFrom !== null && row.noticeOn < historyFrom) {
      const { plan } = await this.entitlements.resolvePlan(orgId);
      throw new AppError(HttpStatus.FORBIDDEN, 'PLAN_UPGRADE_REQUIRED', 'Your plan does not include this. Upgrade to use it.', {
        feature: 'notice_history',
        plan,
      });
    }
    return toItem(row);
  }

  /** How many notices of the last `sinceDays` days fall inside `topic` (commodities include their descendants), within the account's window. */
  async countTopic(orgId: string, topic: TopicFields, sinceDays: number): Promise<number> {
    const historyFrom = await this.entitlements.historyFrom(orgId);
    const since = new Date(Date.now() - sinceDays * DAY_MS).toISOString().slice(0, 10);
    const from = laterOf(since, historyFrom) as string;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notice)
      .where(
        and(
          gte(notice.noticeOn, from),
          topicFilter(
            { originCountry: notice.originCountry, commodityId: notice.commodityId, destination: notice.destination, hazardIds: notice.hazardIds },
            topic,
          ),
        ),
      );
    return row?.count ?? 0;
  }

  /** The countries notices come from: the distinct, non-null `origin_country`, in code order. */
  async originCountries(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ code: notice.originCountry })
      .from(notice)
      .where(isNotNull(notice.originCountry))
      .orderBy(notice.originCountry);
    return rows.map((row) => row.code as string);
  }
}
