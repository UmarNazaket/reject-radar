import { rasffNotification } from '@rejectradar/db';
import { classifyCommodity, classifyHazards, UNCLASSIFIED_ID, type RuleSet } from '@rejectradar/taxonomy';
import { and, desc, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SyncDeps } from '../../core/deps';
import { SourceFetchError } from '../../core/http';
import { insertEvents, upsertNotices, type EventInput, type NoticeInput } from '../../core/notices';
import { eventsForRun, runSync, type SyncRunResult } from '../../core/sync-run';
import {
  parseDetail,
  parseSearchPage,
  rasffDetailUrl,
  rasffNoticeType,
  rasffPublicUrl,
  RASFF_SEARCH_URL,
  type RasffHazard,
  type RasffListItem,
} from './parse';

export { RASFF_SEARCH_URL, rasffDetailUrl, rasffPublicUrl };

/** Days before the newest stored notification that a default run reads again, so late corrections are picked up. */
export const OVERLAP_DAYS = 30;

/** Where a first load starts: the RASFF Window holds notifications from 2020. */
export const FIRST_LOAD_FROM = '2020-01-01';

export const DEFAULT_DETAILS_LIMIT = 200;

const ITEMS_PER_PAGE = 100;
const BATCH_SIZE = 500;
const KEY_CHUNK = 2000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** The product types RASFF uses (compared in lower case); only food and feed are kept. */
const KNOWN_PRODUCT_TYPES = new Set(['food', 'feed', 'food contact material']);
const KEPT_PRODUCT_TYPES = new Set(['food', 'feed']);

/** Whether a listed notification is kept; a product type outside the three known ones fails the run, naming it. */
function isKeptProductType(item: Pick<RasffListItem, 'reference' | 'productType'>): boolean {
  if (item.productType === null) throw new Error(`RASFF notification ${item.reference} has no productType; expected food, feed or food contact material`);
  const type = item.productType.toLowerCase();
  if (!KNOWN_PRODUCT_TYPES.has(type)) {
    throw new Error(`RASFF notification ${item.reference} has an unknown productType "${item.productType}"; expected food, feed or food contact material`);
  }
  return KEPT_PRODUCT_TYPES.has(type);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * The commodity comes from the product category and the subject. Before details exist the hazards come from the subject's
 * keywords; with details each hazard is matched on its name and, only when that finds nothing, on its category. A
 * notification whose hazards match nothing falls back to its subject.
 */
export function classifyRasff(
  rules: RuleSet,
  item: Pick<RasffListItem, 'productCategory' | 'subject'>,
  hazards: readonly RasffHazard[],
): { commodityId: number; hazardIds: number[] } {
  const commodityId = classifyCommodity(rules, 'rasff', { product_category: item.productCategory, subject: item.subject });
  const found = new Set<number>();
  for (const hazard of hazards) {
    let ids = classifyHazards(rules, 'rasff', { hazard_name: [hazard.name] });
    if (ids.includes(UNCLASSIFIED_ID)) ids = classifyHazards(rules, 'rasff', { hazard_category: [hazard.category] });
    for (const id of ids) if (id !== UNCLASSIFIED_ID) found.add(id);
  }
  const hazardIds = found.size > 0 ? [...found].sort((a, b) => a - b) : classifyHazards(rules, 'rasff', { subject: [item.subject] });
  return { commodityId, hazardIds };
}

/** The run result plus how the detail fetches went. */
export interface RasffRunResult extends SyncRunResult {
  detailsFetched: number;
  detailsGone: number;
  detailsInvalid: number;
  detailsTransient: number;
}

/** A notification as stored: the list fields plus what only the detail holds. */
interface Row extends RasffListItem {
  distributionCountries: string[];
  hazards: RasffHazard[];
  isNew: boolean;
  /** Set when this run fetched the detail or gave up on it for good; written as `details_fetched_at = now()`. */
  markFetched: boolean;
}

type StoredRow = typeof rasffNotification.$inferSelect;

/** The numeric id lives only in the public URL we stored. */
const notifIdOf = (url: string | null): number | null => {
  const id = Number(/(\d+)\/?$/.exec(url ?? '')?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const rowFromStored = (s: StoredRow): Row | null => {
  const notifId = notifIdOf(s.url);
  if (notifId === null) return null;
  return {
    notifId,
    reference: s.reference,
    notifiedOn: s.notifiedOn,
    subject: s.subject,
    productCategory: s.productCategory,
    productType: null,
    classification: s.classification,
    riskDecision: s.riskDecision,
    notifyingCountry: s.notifyingCountry,
    originCountries: s.originCountries,
    distributionCountries: s.distributionCountries,
    hazards: s.hazards as RasffHazard[],
    isNew: false,
    markFetched: false,
  };
};

/** Pages the search newest first until a page reaches back before the cutoff (or the list ends). */
async function readList(deps: SyncDeps, cutoff: string): Promise<{ read: number; items: RasffListItem[] }> {
  const byReference = new Map<string, RasffListItem>();
  let read = 0;
  for (let page = 1; ; page++) {
    const response = await deps.fetcher(RASFF_SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parameters: { pageNumber: page, itemsPerPage: ITEMS_PER_PAGE } }),
      expect: 'json',
    });
    const { items, totalPages } = parseSearchPage(response.json());
    read += items.length;
    // A notification can move between pages while we read; keep the first copy.
    for (const item of items) {
      if (isKeptProductType(item) && !byReference.has(item.reference)) byReference.set(item.reference, item);
    }
    if (items.length === 0 || page >= totalPages) break;
    if (items.reduce((oldest, item) => (item.notifiedOn < oldest ? item.notifiedOn : oldest), items[0].notifiedOn) < cutoff) break;
  }
  return { read, items: [...byReference.values()] };
}

/**
 * Syncs RASFF notifications of food and feed into `rasff_notification` and `notice`, in one transaction. The search list
 * is read newest first back to the cutoff (`from`, else 30 days before the newest stored notification). Hazards live only
 * in each notification's detail: up to `detailsLimit` details are fetched per run, new references first, then stored
 * ones never fetched (oldest first). A detail that is gone or malformed is given up on; a transient failure is retried
 * next run. Events are emitted for new references only.
 */
export async function syncRasff(
  deps: SyncDeps,
  options: { from?: string; detailsLimit: number; events: boolean },
): Promise<RasffRunResult> {
  if (options.from !== undefined && !DATE_ONLY.test(options.from)) throw new Error(`Invalid date "${options.from}"; use YYYY-MM-DD`);
  if (!Number.isSafeInteger(options.detailsLimit) || options.detailsLimit < 0) throw new Error('detailsLimit must be a whole number of 0 or more');

  const skipped = { gone: 0, invalid: 0, transient: 0 };
  let fetched = 0;
  const result = await runSync(deps.db, 'rasff', async (ctx) => {
    const emitEvents = await eventsForRun(deps.db, 'rasff', options.events);
    ctx.setOrigin(RASFF_SEARCH_URL);

    let cutoff = options.from;
    if (cutoff === undefined) {
      const [newest] = await deps.db
        .select({ notifiedOn: rasffNotification.notifiedOn })
        .from(rasffNotification)
        .orderBy(desc(rasffNotification.notifiedOn))
        .limit(1);
      cutoff = newest ? addDays(newest.notifiedOn, -OVERLAP_DAYS) : FIRST_LOAD_FROM;
    }

    const list = await readList(deps, cutoff);
    ctx.counts.rowsRead = list.read;

    // Rows this run writes: every listed notification, plus stored ones whose details are fetched now.
    const stored = new Map<string, StoredRow>();
    for (const part of chunks(list.items.map((item) => item.reference), KEY_CHUNK)) {
      for (const row of await deps.db.select().from(rasffNotification).where(inArray(rasffNotification.reference, part))) stored.set(row.reference, row);
    }
    const rows = new Map<string, Row>();
    for (const item of list.items) {
      const before = stored.get(item.reference);
      rows.set(item.reference, {
        ...item,
        // The list names no origin for about 1% of notifications; keep what an earlier detail gave.
        originCountries: item.originCountries.length > 0 ? item.originCountries : (before?.originCountries ?? []),
        distributionCountries: before?.distributionCountries ?? [],
        hazards: (before?.hazards as RasffHazard[] | undefined) ?? [],
        isNew: before === undefined,
        markFetched: false,
      });
    }

    // New references come first, newest first as listed; the remaining slots go to stored rows whose details were never
    // fetched, oldest first, so a backlog can never starve fresh notifications.
    const toDetail = [...rows.values()].filter((row) => row.isNew).slice(0, options.detailsLimit);
    const spare = options.detailsLimit - toDetail.length;
    if (spare > 0) {
      const backlog = await deps.db
        .select()
        .from(rasffNotification)
        .where(and(isNull(rasffNotification.detailsFetchedAt), isNotNull(rasffNotification.url)))
        .orderBy(rasffNotification.notifiedOn, rasffNotification.reference)
        .limit(spare);
      for (const s of backlog) {
        const row = rows.get(s.reference) ?? rowFromStored(s);
        if (row !== null) toDetail.push(row);
      }
    }

    for (const row of toDetail) {
      // A gone or malformed detail is given up on (marked fetched); a transient failure is left to the next run.
      let json: unknown;
      try {
        json = (await deps.fetcher(rasffDetailUrl(row.notifId), { expect: 'json' })).json();
      } catch (error) {
        if (error instanceof SourceFetchError && (error.status === 404 || error.status === 410)) {
          skipped.gone++;
          row.markFetched = true;
        } else if (error instanceof SourceFetchError || !(error instanceof SyntaxError)) {
          skipped.transient++;
        } else {
          skipped.invalid++;
          row.markFetched = true;
        }
        rows.set(row.reference, row);
        continue;
      }
      let detail: ReturnType<typeof parseDetail>;
      try {
        detail = parseDetail(json);
      } catch {
        skipped.invalid++;
        row.markFetched = true;
        rows.set(row.reference, row);
        continue;
      }
      row.hazards = detail.hazards;
      row.distributionCountries = detail.distributionCountries;
      if (row.originCountries.length === 0) row.originCountries = detail.originCountries;
      row.markFetched = true;
      fetched++;
      rows.set(row.reference, row);
    }
    if (skipped.gone + skipped.invalid + skipped.transient > 0) {
      console.warn(
        `RASFF details skipped: ${skipped.gone} gone (404/410), ${skipped.invalid} invalid, ${skipped.transient} failed transiently and will be retried next run.`,
      );
    }

    // Classify everything before writing; one bad record fails the run with nothing written.
    const written = [...rows.values()].map((row) => ({ row, ...classifyRasff(deps.rules, row, row.hazards) }));

    const now = new Date();
    let rowsInserted = 0;
    let rowsUpdated = 0;
    let eventsEmitted = 0;

    await deps.db.transaction(async (tx) => {
      for (const batch of chunks(written, BATCH_SIZE)) {
        const returned = await tx
          .insert(rasffNotification)
          .values(
            batch.map(({ row, commodityId, hazardIds }) => ({
              reference: row.reference,
              notifiedOn: row.notifiedOn,
              classification: row.classification,
              riskDecision: row.riskDecision,
              notifyingCountry: row.notifyingCountry,
              originCountries: row.originCountries,
              distributionCountries: row.distributionCountries,
              productCategory: row.productCategory,
              subject: row.subject,
              hazards: row.hazards,
              commodityId,
              hazardIds,
              url: rasffPublicUrl(row.notifId),
              detailsFetchedAt: row.markFetched ? now : null,
            })),
          )
          .onConflictDoUpdate({
            target: rasffNotification.reference,
            set: {
              notifiedOn: sql`excluded.notified_on`,
              classification: sql`excluded.classification`,
              riskDecision: sql`excluded.risk_decision`,
              notifyingCountry: sql`excluded.notifying_country`,
              originCountries: sql`excluded.origin_countries`,
              distributionCountries: sql`excluded.distribution_countries`,
              productCategory: sql`excluded.product_category`,
              subject: sql`excluded.subject`,
              hazards: sql`excluded.hazards`,
              commodityId: sql`excluded.commodity_id`,
              hazardIds: sql`excluded.hazard_ids`,
              url: sql`excluded.url`,
              detailsFetchedAt: sql`coalesce(excluded.details_fetched_at, ${rasffNotification.detailsFetchedAt})`,
            },
            setWhere: sql`(${rasffNotification.notifiedOn}, ${rasffNotification.classification}, ${rasffNotification.riskDecision}, ${rasffNotification.notifyingCountry}, ${rasffNotification.originCountries}, ${rasffNotification.distributionCountries}, ${rasffNotification.productCategory}, ${rasffNotification.subject}, ${rasffNotification.hazards}, ${rasffNotification.commodityId}, ${rasffNotification.hazardIds}, ${rasffNotification.url}, ${rasffNotification.detailsFetchedAt})
              is distinct from
              (excluded.notified_on, excluded.classification, excluded.risk_decision, excluded.notifying_country, excluded.origin_countries, excluded.distribution_countries, excluded.product_category, excluded.subject, excluded.hazards, excluded.commodity_id, excluded.hazard_ids, excluded.url, coalesce(excluded.details_fetched_at, ${rasffNotification.detailsFetchedAt}))`,
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        for (const r of returned) {
          if (r.inserted) rowsInserted++;
          else rowsUpdated++;
        }
      }

      const notices: NoticeInput[] = written.map(({ row, commodityId, hazardIds }) => ({
        source: 'rasff',
        sourceKey: row.reference,
        noticeType: rasffNoticeType(row.classification),
        noticeOn: row.notifiedOn,
        originCountry: row.originCountries[0] ?? null,
        commodityId,
        hazardIds,
        productText: row.subject,
        firmName: null,
        title: row.subject,
        url: rasffPublicUrl(row.notifId),
      }));
      const upserted = await upsertNotices(tx, notices);

      if (emitEvents) {
        const events: EventInput[] = [];
        for (const { row, commodityId, hazardIds } of written) {
          const notice = upserted.get(row.reference);
          if (!row.isNew || !notice?.inserted) continue;
          events.push({
            source: 'rasff',
            sourceKey: row.reference,
            kind: 'rasff_notification',
            occurredOn: row.notifiedOn,
            requiresFirm: false,
            originCountry: row.originCountries[0] ?? null,
            commodityId,
            hazardIds,
            noticeId: notice.id,
          });
        }
        eventsEmitted = await insertEvents(tx, events);
      }
    });

    ctx.counts.rowsInserted = rowsInserted;
    ctx.counts.rowsUpdated = rowsUpdated;
    ctx.counts.eventsEmitted = eventsEmitted;
  });
  return { ...result, detailsFetched: fetched, detailsGone: skipped.gone, detailsInvalid: skipped.invalid, detailsTransient: skipped.transient };
}
