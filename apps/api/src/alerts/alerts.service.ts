import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  AlertItem,
  AlertsQuery,
  AlertsResponse,
  Destination,
  DigestFrequency,
  EventKind,
  MarkReadRequest,
  MarkReadResponse,
  NoticeType,
  NotificationPrefs,
  Severity,
  TopicFields,
} from '@rejectradar/contracts';
import { alert, changeEvent, type Database, firm, notice, notificationPref, topicFilter, topicMatchesItem } from '@rejectradar/db';
import { count, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { decodeTimeCursor, encodeTimeCursor } from '../common/cursor';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';

/** What a user has before they save anything (P5-D13): instant emails for high-severity alerts, and a daily digest. */
export const DEFAULT_PREFS: NotificationPrefs = { instantHigh: true, digest: 'daily' };

/** The alert's creation time as Postgres prints it, to the microsecond: a `Date` holds only milliseconds, and the keyset position needs the rest. */
const CREATED_AT_TEXT = sql<string>`to_char(${alert.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** What the watchlist tells the alerts module about an item: a firm item has `firmId`, a topic item has `topic`. */
export interface UnreadCountItem {
  id: string;
  firmId: number | null;
  topic: TopicFields | null;
}

/**
 * The account's in-app alerts (spec §7.4, §11) and each user's notification settings. `alerts:run` (Task 13) creates
 * the rows; this module lists them, marks them read and counts the unread ones per watched item. It owns `alert`,
 * `alert_email` and `notification_pref`, and reads `change_event` and, to display an alert, `firm` and `notice`.
 */
@Injectable()
export class AlertsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** One page, newest first (`created_at desc, id desc`, P5-D5). `unread` counts all of the account's unread alerts, whatever the filters. */
  async list(ctx: RequestContext, query: AlertsQuery, pageSize = 50): Promise<AlertsResponse> {
    const conditions: (SQL | undefined)[] = [];
    if (query.severity) conditions.push(eq(alert.severity, query.severity));
    if (query.unread) conditions.push(isNull(alert.readAt));
    if (query.firm !== undefined) conditions.push(eq(alert.firmId, query.firm));
    if (query.origin !== undefined) {
      // A topic always starts with its origin (the query schema refuses the other parts without it); parts left out mean "any".
      const topic: TopicFields = {
        originCountry: query.origin,
        commodityId: query.commodity ?? null,
        destination: query.destination ?? null,
        hazardId: query.hazard ?? null,
      };
      conditions.push(
        topicFilter(
          { originCountry: changeEvent.originCountry, commodityId: changeEvent.commodityId, destination: changeEvent.destination, hazardIds: changeEvent.hazardIds },
          topic,
        ),
      );
    }
    if (query.cursor) {
      const cursor = decodeTimeCursor(query.cursor);
      conditions.push(sql`(${alert.createdAt}, ${alert.id}) < (${cursor.timestamp}::timestamptz, ${cursor.id}::uuid)`);
    }

    // One row more than the page tells whether another page follows.
    const [rows, unread] = await Promise.all([
      this.rows(byOrg(alert, ctx, ...conditions))
        .orderBy(desc(alert.createdAt), desc(alert.id))
        .limit(pageSize + 1),
      this.unread(ctx),
    ]);

    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    return { items: page.map(toItem), next: rows.length > pageSize && last ? encodeTimeCursor(last.createdAt, last.id) : null, unread };
  }

  /** One of the account's alerts, for the page an alert email links to; another account's id is not found. */
  async get(ctx: RequestContext, id: string): Promise<AlertItem> {
    const [row] = await this.rows(byOrg(alert, ctx, eq(alert.id, id)));
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    return toItem(row);
  }

  /** Marks some of the account's alerts, or all its unread ones, as read. Ids of other accounts match nothing; alerts already read are left as they are. */
  async markRead(ctx: RequestContext, body: MarkReadRequest): Promise<MarkReadResponse> {
    const target = 'ids' in body ? inArray(alert.id, body.ids) : undefined;
    const marked = await this.db
      .update(alert)
      .set({ readAt: sql`now()` })
      .where(byOrg(alert, ctx, isNull(alert.readAt), target))
      .returning({ id: alert.id });
    return { updated: marked.length };
  }

  /**
   * The unread alerts of each watched item, for the watchlist, in one statement. A firm item counts the alerts of its
   * firm (`alert.firm_id`); a topic item counts the alerts whose event falls inside the topic (spec §11, P5-D6).
   * Every item is in the result, with 0 when it has none (the map starts at 0; the statement returns only items that have alerts).
   */
  async unreadCounts(orgId: string, items: UnreadCountItem[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(items.map((item) => [item.id, 0]));
    if (items.length === 0) return counts;

    const values = sql.join(
      items.map(
        (item) =>
          sql`(${item.id}::uuid, ${item.firmId}::bigint, ${item.topic?.originCountry ?? null}::text, ${item.topic?.commodityId ?? null}::int, ${item.topic?.destination ?? null}::text, ${item.topic?.hazardId ?? null}::int)`,
      ),
      sql`, `,
    );
    const ancestors = sql`(select c.ancestor_ids from commodity c where c.id = ${changeEvent.commodityId})`;
    // Two branches, so each join has an equality the planner can hash: the firm branch joins on the firm id, the topic
    // branch on the origin country (inside topicMatchesItem). One OR of the two would force a nested loop over
    // items x unread alerts. An item is a firm or a topic, never both (watchlist_item_kind_ck), so no alert is counted twice for one item.
    const { rows } = await this.db.execute<{ id: string; unread: number }>(sql`
      with item(id, firm_id, origin_country, commodity_id, destination, hazard_id) as (values ${values}),
      unread as (
        select ${alert.id} as id, ${alert.firmId} as firm_id, ${changeEvent.originCountry} as origin_country,
               ${changeEvent.commodityId} as commodity_id, ${changeEvent.destination} as destination, ${changeEvent.hazardIds} as hazard_ids,
               ${ancestors} as ancestor_ids
        from ${alert} join ${changeEvent} on ${changeEvent.id} = ${alert.changeEventId}
        where ${alert.orgId} = ${orgId} and ${alert.readAt} is null
      )
      select matched.id, count(*)::int as unread
      from (
        select item.id, unread.id as alert_id
        from item join unread on unread.firm_id = item.firm_id
        union all
        select item.id, unread.id as alert_id
        from item join unread on ${topicMatchesItem(
          { originCountry: sql`unread.origin_country`, commodityId: sql`unread.commodity_id`, destination: sql`unread.destination`, hazardIds: sql`unread.hazard_ids` },
          { originCountry: sql`item.origin_country`, commodityId: sql`item.commodity_id`, destination: sql`item.destination`, hazardId: sql`item.hazard_id` },
          sql`unread.ancestor_ids`,
        )}
      ) matched
      group by matched.id`);
    for (const row of rows) counts.set(row.id, row.unread);
    return counts;
  }

  /** The user's settings, or the defaults while they have saved none (P5-D13). */
  async getPrefs(ctx: RequestContext): Promise<NotificationPrefs> {
    const [row] = await this.db
      .select({ instantHigh: notificationPref.instantHigh, digest: notificationPref.digest })
      .from(notificationPref)
      .where(eq(notificationPref.userId, ctx.userId));
    return row ? { instantHigh: row.instantHigh, digest: row.digest as DigestFrequency } : { ...DEFAULT_PREFS };
  }

  /** Saves the settings of the calling user: per user, not per account. The time of the last digest belongs to the digest job and stays as it is. */
  async savePrefs(ctx: RequestContext, prefs: NotificationPrefs): Promise<NotificationPrefs> {
    await this.db
      .insert(notificationPref)
      .values({ userId: ctx.userId, instantHigh: prefs.instantHigh, digest: prefs.digest })
      .onConflictDoUpdate({ target: notificationPref.userId, set: { instantHigh: prefs.instantHigh, digest: prefs.digest, updatedAt: sql`now()` } });
    return this.getPrefs(ctx);
  }

  /** The alerts with what displays them: the event, the firm and the notice. */
  private rows(where: SQL | undefined) {
    return this.db
      .select({
        id: alert.id,
        severity: alert.severity,
        readAt: alert.readAt,
        createdAt: CREATED_AT_TEXT,
        kind: changeEvent.kind,
        occurredOn: changeEvent.occurredOn,
        firmId: firm.id,
        firmName: firm.displayName,
        noticeId: notice.id,
        noticeType: notice.noticeType,
        destination: notice.destination,
        originCountry: notice.originCountry,
        productText: notice.productText,
        title: notice.title,
        url: notice.url,
      })
      .from(alert)
      .innerJoin(changeEvent, eq(changeEvent.id, alert.changeEventId))
      .leftJoin(firm, eq(firm.id, alert.firmId))
      .leftJoin(notice, eq(notice.id, changeEvent.noticeId))
      .where(where);
  }

  private async unread(ctx: RequestContext): Promise<number> {
    const [row] = await this.db.select({ unread: count() }).from(alert).where(byOrg(alert, ctx, isNull(alert.readAt)));
    return row.unread;
  }
}

type AlertRow = Awaited<ReturnType<AlertsService['rows']>>[number];

function toItem(row: AlertRow): AlertItem {
  return {
    id: row.id,
    severity: row.severity as Severity,
    kind: row.kind as EventKind,
    createdAt: new Date(row.createdAt).toISOString(),
    occurredOn: row.occurredOn,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    firm: row.firmId !== null && row.firmName !== null ? { id: row.firmId, displayName: row.firmName } : null,
    notice:
      row.noticeId === null
        ? null
        : {
            id: row.noticeId,
            noticeType: row.noticeType as NoticeType,
            destination: row.destination as Destination,
            originCountry: row.originCountry,
            productText: row.productText,
            title: row.title,
            url: row.url,
          },
  };
}
