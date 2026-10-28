import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  buildTopicKey,
  type CreateWatchlistItemRequest,
  type TopicEstimateResponse,
  type TopicFields,
  type UpdateWatchlistItemRequest,
  type WatchlistItem,
  type WatchlistKind,
  type WatchlistResponse,
} from '@rejectradar/contracts';
import { type Database, notice, topicMatchesItem, uuidv7, watchlistItem } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { toCsvRow } from '../common/csv';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { FirmProfileService } from '../firms/firm-profile.service';
import { NoticesService, TODAY } from '../notices/notices.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';

/** The watchlist and the dashboards count the same window: the last 12 calendar months (P5-D6). */
const WINDOW_MONTHS = 12;

/** The unique indexes of `watchlist_item`; a violation of either means the account watches this already. */
const UNIQUE_INDEXES = ['watchlist_item_org_firm_uq', 'watchlist_item_org_topic_uq'];

export const CSV_HEADER = ['kind', 'name', 'label', 'notes', 'country', 'commodity', 'destination', 'hazard', 'last_record_on', 'unread_alerts'] as const;

type ItemRow = {
  id: string;
  kind: string;
  firmId: string | number | null;
  originCountry: string | null;
  commodityId: number | null;
  destination: string | null;
  hazardId: number | null;
  inputName: string | null;
  label: string | null;
  notes: string | null;
  createdAt: Date | string;
  notices12m: number | null;
  lastTopicOn: string | null;
};

const alreadyWatched = () => new AppError(HttpStatus.CONFLICT, 'ALREADY_WATCHED', 'This is already on your watchlist.');
const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');

/** True when `error`, or an error it wraps (Drizzle wraps the driver's), is a unique violation on one of the watchlist indexes. */
function isAlreadyWatched(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const { code, constraint, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (code === '23505' && typeof constraint === 'string' && UNIQUE_INDEXES.includes(constraint)) return true;
    current = cause;
  }
  return false;
}

/** Text a user typed, trimmed; blank means "none". */
const orNull = (text: string | null | undefined): string | null => (text === undefined || text === null || text.trim() === '' ? null : text.trim());

/**
 * The account's watchlist (spec §7.2, §11): the firms and topics it wants alerts for. The places an account holds come
 * from its plan (P5-D2): adding counts the rows under a per-account advisory lock, so two adds of the last place take turns.
 */
@Injectable()
export class WatchlistsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
    private readonly firms: FirmProfileService,
    private readonly notices: NoticesService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  async list(ctx: RequestContext): Promise<WatchlistResponse> {
    const [items, { limits }] = await Promise.all([this.load(ctx), this.entitlements.resolvePlan(ctx.orgId)]);
    return { items, used: items.length, limit: limits.watchlistSize };
  }

  async add(ctx: RequestContext, body: CreateWatchlistItemRequest): Promise<WatchlistItem> {
    const target = await this.resolveTarget(body);
    const row = { id: uuidv7(), orgId: ctx.orgId, addedBy: ctx.userId, label: orNull(body.label), notes: orNull(body.notes), ...target.columns };
    try {
      await this.db.transaction(async (tx) => {
        // The count and the insert are one step per account, so two adds of the last place cannot both pass.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('watchlist:' || ${ctx.orgId}::text, 0))`);
        const result = await tx.execute<{ used: number; duplicate: boolean }>(sql`
          select count(*)::int as used, coalesce(bool_or(${target.same}), false) as duplicate
          from ${watchlistItem} where ${byOrg(watchlistItem, ctx)}`);
        const { used, duplicate } = result.rows[0];
        // Watching something twice is a conflict even on a full list; it asks for no place.
        if (duplicate) throw alreadyWatched();
        await this.entitlements.assertCount(ctx.orgId, 'watchlist', used, tx);
        await tx.insert(watchlistItem).values(row);
      });
    } catch (error) {
      if (isAlreadyWatched(error)) throw alreadyWatched();
      throw error;
    }
    return this.one(ctx, row.id);
  }

  /** Changes the label and notes; `null` clears one. Another account's item is `404`, like one that is not there. */
  async update(ctx: RequestContext, id: string, body: UpdateWatchlistItemRequest): Promise<WatchlistItem> {
    const changes: { label?: string | null; notes?: string | null } = {};
    if (body.label !== undefined) changes.label = orNull(body.label);
    if (body.notes !== undefined) changes.notes = orNull(body.notes);
    const updated = await this.db
      .update(watchlistItem)
      .set(changes)
      .where(byOrg(watchlistItem, ctx, eq(watchlistItem.id, id)))
      .returning({ id: watchlistItem.id });
    if (updated.length === 0) throw notFound();
    return this.one(ctx, id);
  }

  async remove(ctx: RequestContext, id: string): Promise<void> {
    const removed = await this.db.delete(watchlistItem).where(byOrg(watchlistItem, ctx, eq(watchlistItem.id, id))).returning({ id: watchlistItem.id });
    if (removed.length === 0) throw notFound();
  }

  /** How many notices a topic had in the last 12 months, and the monthly average, before the account adds it. */
  async estimate(ctx: RequestContext, topic: TopicFields): Promise<TopicEstimateResponse> {
    await this.assertKnown(topic.commodityId, topic.hazardId);
    const total12m = await this.notices.countTopic(ctx.orgId, topic, WINDOW_MONTHS);
    return { total12m, perMonth: Math.round((total12m / WINDOW_MONTHS) * 10) / 10 };
  }

  /** The watchlist as CSV (P5-D16): the header, then one line per item, each ending in CRLF. */
  async exportCsv(ctx: RequestContext): Promise<string> {
    const { items } = await this.list(ctx);
    const lines = items.map((item) =>
      toCsvRow([
        item.kind,
        item.firm?.displayName ?? null,
        item.label,
        item.notes,
        item.firm?.countryCode ?? item.topic?.originCountry ?? null,
        item.topic?.commodityId ?? null,
        item.topic?.destination ?? null,
        item.topic?.hazardId ?? null,
        item.lastRecordOn,
        item.unreadAlerts,
      ]),
    );
    return [toCsvRow(CSV_HEADER), ...lines].map((line) => `${line}\r\n`).join('');
  }

  /** The columns a request stores, and the condition that tells whether a row is the same thing. A merged-away firm is stored as its survivor (P5-D9). */
  private async resolveTarget(body: CreateWatchlistItemRequest) {
    if (body.kind === 'firm') {
      const firmId = await this.firms.resolveId(body.firmId);
      if (firmId === null) throw notFound();
      return {
        columns: { kind: 'firm', firmId, inputName: orNull(body.inputName) },
        same: sql`${watchlistItem.kind} = 'firm' and ${watchlistItem.firmId} = ${firmId}::bigint`,
      };
    }
    const topic: TopicFields = {
      originCountry: body.originCountry,
      commodityId: body.commodityId ?? null,
      destination: body.destination ?? null,
      hazardId: body.hazardId ?? null,
    };
    await this.assertKnown(topic.commodityId, topic.hazardId);
    const topicKey = buildTopicKey(topic);
    return { columns: { kind: 'topic', ...topic, topicKey }, same: sql`${watchlistItem.kind} = 'topic' and ${watchlistItem.topicKey} = ${topicKey}` };
  }

  private async assertKnown(commodityId: number | null, hazardId: number | null): Promise<void> {
    if (commodityId !== null && !(await this.taxonomy.commodityExists(commodityId))) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'That commodity does not exist.');
    }
    if (hazardId !== null && !(await this.taxonomy.hazardExists(hazardId))) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'That hazard does not exist.');
    }
  }

  private async one(ctx: RequestContext, id: string): Promise<WatchlistItem> {
    const [item] = await this.load(ctx, id);
    if (!item) throw notFound();
    return item;
  }

  /**
   * The account's items, newest first (or just item `id`). Each topic's `notices12m` comes from one lateral join over
   * `notice`, inside the same window as the dashboard's `totals12m`: from `today - 12 months`, and no earlier than the
   * plan's history. Firm facts come from the firms module in one call.
   */
  private async load(ctx: RequestContext, id?: string): Promise<WatchlistItem[]> {
    const historyFrom = await this.entitlements.historyFrom(ctx.orgId);
    const since = sql`greatest((${TODAY} - make_interval(months => ${WINDOW_MONTHS}))::date, ${historyFrom}::date)`;
    const ancestors = sql`(select c.ancestor_ids from commodity c where c.id = ${notice.commodityId})`;
    const { rows } = await this.db.execute<ItemRow>(sql`
      select ${watchlistItem.id} as id, ${watchlistItem.kind} as kind, ${watchlistItem.firmId} as "firmId",
             ${watchlistItem.originCountry} as "originCountry", ${watchlistItem.commodityId} as "commodityId",
             ${watchlistItem.destination} as destination, ${watchlistItem.hazardId} as "hazardId",
             ${watchlistItem.inputName} as "inputName", ${watchlistItem.label} as label, ${watchlistItem.notes} as notes,
             ${watchlistItem.createdAt} as "createdAt", topic.notices as "notices12m",
             to_char(topic.last_on, 'YYYY-MM-DD') as "lastTopicOn"
      from ${watchlistItem}
      left join lateral (
        select count(*)::int as notices, max(${notice.noticeOn}) as last_on
        from ${notice}
        where ${watchlistItem.kind} = 'topic'
          and ${notice.noticeOn} >= ${since}
          and ${topicMatchesItem(
            { originCountry: notice.originCountry, commodityId: notice.commodityId, destination: notice.destination, hazardIds: notice.hazardIds },
            { originCountry: watchlistItem.originCountry, commodityId: watchlistItem.commodityId, destination: watchlistItem.destination, hazardId: watchlistItem.hazardId },
            ancestors,
          )}
      ) topic on true
      where ${byOrg(watchlistItem, ctx, id === undefined ? undefined : eq(watchlistItem.id, id))}
      order by ${watchlistItem.createdAt} desc, ${watchlistItem.id} desc`);

    const firmIds = rows.flatMap((row) => (row.firmId === null ? [] : [Number(row.firmId)]));
    const facts = await this.firms.summaryFacts(firmIds);
    return rows.map((row) => {
      const kind = row.kind as WatchlistKind;
      const firm = row.firmId === null ? undefined : facts.get(Number(row.firmId));
      if (kind === 'firm' && firm === undefined) throw new Error(`Watchlist item ${row.id} names a firm that does not exist`);
      return {
        id: row.id,
        kind,
        firm: firm ? { id: firm.id, displayName: firm.displayName, countryCode: firm.countryCode, facts: firm.facts } : null,
        topic:
          kind === 'topic'
            ? {
                originCountry: row.originCountry as string,
                commodityId: row.commodityId,
                destination: row.destination as TopicFields['destination'],
                hazardId: row.hazardId,
                notices12m: row.notices12m ?? 0,
              }
            : null,
        inputName: row.inputName,
        label: row.label,
        notes: row.notes,
        lastRecordOn: kind === 'firm' ? (firm?.lastNoticeOn ?? null) : row.lastTopicOn,
        // Task 11 fills this from `AlertsService.unreadCounts`.
        unreadAlerts: 0,
        createdAt: new Date(row.createdAt).toISOString(),
      };
    });
  }
}
