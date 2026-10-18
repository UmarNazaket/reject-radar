import type { AlertList, EventKind } from '@rejectradar/contracts';
import { importAlert, importAlertListing, importAlertListingProduct, notice } from '@rejectradar/db';
import { normalizeAddressLine, normalizeName } from '@rejectradar/matching';
import { classifyCommodity, classifyHazards, UNCLASSIFIED_ID, type RuleSet } from '@rejectradar/taxonomy';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SyncDeps } from '../../core/deps';
import { insertEvents, upsertNotices, type EventInput, type NoticeInput } from '../../core/notices';
import { runSync, type SyncRunResult, type Tx } from '../../core/sync-run';
import { isFoodAlert, parseAlertIndex, type AlertIndexEntry } from './parse-index';
import { PageStructureError, parseAlertPage, type ParsedAlert, type ParsedListing, type ParsedListingProduct } from './parse-page';

export const IMPORT_ALERT_INDEX_URL = 'https://www.accessdata.fda.gov/cms_ia/ialist.html';

/** A listing that is missing from this many consecutive successful runs is delisted (spec §6.5). */
export const MISSED_RUNS_TO_DELIST = 2;

const BATCH_SIZE = 500;
const KEY_CHUNK = 5000;

/** Identity of a listing: the alert, the normalised firm name, the country and the normalised address. */
export function listingKey(alertNumber: string, l: ParsedListing): string {
  const parts = [alertNumber, normalizeName(l.firmName).primary, l.countryCode ?? '', normalizeAddressLine(l.addressRaw) ?? ''];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

/** Commodity from the first product's industry code and all product names; hazards from the alert title and product problems. */
export function classifyListing(rules: RuleSet, alert: Pick<ParsedAlert, 'title'>, l: ParsedListing): { commodityId: number; hazardIds: number[] } {
  const names = l.products.map((p) => p.productName).filter((name): name is string => !!name);
  return {
    commodityId: classifyCommodity(rules, 'import_alert', {
      industry_code: l.products[0]?.industryCode ?? null,
      product_name: names.length > 0 ? names.join('; ') : null,
    }),
    hazardIds: classifyHazards(rules, 'import_alert', { title: [alert.title], problem: l.products.flatMap((p) => p.problems) }),
  };
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Saves the page that failed to parse under `<failureDir>/<name>-<timestamp>.html` and returns the path. */
async function saveSample(failureDir: string, name: string, sample: string): Promise<string> {
  await mkdir(failureDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(failureDir, `${name}-${stamp}.html`);
  await writeFile(file, sample, 'utf8');
  return file;
}

/** Runs `parse`; a page-structure failure saves its HTML and is rethrown with the saved path in the message. */
async function parseOrSaveSample<T>(failureDir: string, name: string, parse: () => T): Promise<T> {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof PageStructureError)) throw error;
    const file = await saveSample(failureDir, name, error.sample);
    throw new PageStructureError(`${error.message} (page saved to ${file})`, error.sample);
  }
}

interface Crawl {
  indexSha256: string;
  /** Every food alert in the index, whether or not this run fetches it. */
  foodNumbers: Set<string>;
  alerts: { entry: AlertIndexEntry; alert: ParsedAlert }[];
}

/** Reads the index and every selected food alert page into memory; nothing is written until all of them parsed. */
async function crawl(deps: SyncDeps & { failureDir: string }, only: string[] | undefined): Promise<Crawl> {
  const index = await deps.fetcher(IMPORT_ALERT_INDEX_URL, { expect: 'html' });
  const entries = await parseOrSaveSample(deps.failureDir, 'index', () => parseAlertIndex(index.text(), IMPORT_ALERT_INDEX_URL));
  const food = entries.filter(isFoodAlert);
  if (food.length === 0) throw new Error('The Import Alert index lists no food alerts; the page layout has probably changed.');

  let selected = food;
  if (only !== undefined) {
    const missing = only.filter((number) => !food.some((entry) => entry.number === number));
    if (missing.length > 0) throw new Error(`Not food alerts in the Import Alert index: ${missing.join(', ')}`);
    selected = food.filter((entry) => only.includes(entry.number));
  }

  const alerts: Crawl['alerts'] = [];
  for (const entry of selected) {
    const page = await deps.fetcher(entry.url, { expect: 'html' });
    const html = page.text();
    const alert = await parseOrSaveSample(deps.failureDir, entry.number, () => {
      const parsed = parseAlertPage(html, entry.url);
      if (parsed.number !== entry.number) {
        throw new PageStructureError(`${entry.url}: the page is alert ${parsed.number} but the index says ${entry.number}`, html);
      }
      return parsed;
    });
    alerts.push({ entry, alert });
  }
  return { indexSha256: index.sha256, foodNumbers: new Set(food.map((entry) => entry.number)), alerts };
}

interface PreparedListing {
  key: string;
  alertNumber: string;
  alertTitle: string;
  alertUrl: string;
  listing: ParsedListing;
  commodityId: number;
  hazardIds: number[];
}

/** FDA repeats some firm blocks verbatim; identical products are kept once. */
function mergeProducts(a: ParsedListingProduct[], b: ParsedListingProduct[]): ParsedListingProduct[] {
  const bySignature = new Map([...a, ...b].map((p) => [productSignature(p), p]));
  return [...bySignature.values()];
}

/** One entry per listing key; if a firm block repeats, the products are merged and a Red List entry wins. */
function prepareListings(rules: RuleSet, crawled: Crawl['alerts']): PreparedListing[] {
  const byKey = new Map<string, PreparedListing>();
  for (const { entry, alert } of crawled) {
    for (const listing of alert.listings) {
      const key = listingKey(alert.number, listing);
      const previous = byKey.get(key);
      const merged: ParsedListing = previous
        ? { ...(previous.listing.list === 'red' || listing.list !== 'red' ? previous.listing : listing), products: mergeProducts(previous.listing.products, listing.products) }
        : listing;
      byKey.set(key, { key, alertNumber: alert.number, alertTitle: alert.title, alertUrl: entry.url, listing: merged, ...classifyListing(rules, alert, merged) });
    }
  }
  return [...byKey.values()];
}

const productSignature = (p: Pick<ParsedListingProduct, 'productCode' | 'productName' | 'description' | 'listedOn' | 'notes'>): string =>
  JSON.stringify([p.productCode, p.productName, p.description, p.listedOn, p.notes]);

const sameProducts = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, i) => value === right[i]);
};

type ListingRow = typeof importAlertListing.$inferSelect;

interface EventDraft {
  key: string;
  kind: Extract<EventKind, 'import_alert_listed' | 'import_alert_delisted'>;
  occurredOn: string;
  originCountry: string | null;
  payload: Record<string, unknown>;
  fallback?: { commodityId: number; hazardIds: number[] };
}

async function loadExisting(tx: Tx, alertNumbers: string[]): Promise<{ rows: ListingRow[]; products: Map<number, string[]>; codes: Map<number, Set<string>> }> {
  const rows: ListingRow[] = [];
  const products = new Map<number, string[]>();
  const codes = new Map<number, Set<string>>();
  if (alertNumbers.length === 0) return { rows, products, codes };
  rows.push(...(await tx.select().from(importAlertListing).where(inArray(importAlertListing.alertNumber, alertNumbers))));
  const stored = await tx
    .select({
      listingId: importAlertListingProduct.listingId,
      productCode: importAlertListingProduct.productCode,
      productName: importAlertListingProduct.productName,
      description: importAlertListingProduct.description,
      listedOn: importAlertListingProduct.listedOn,
      notes: importAlertListingProduct.notes,
    })
    .from(importAlertListingProduct)
    .innerJoin(importAlertListing, eq(importAlertListing.id, importAlertListingProduct.listingId))
    .where(inArray(importAlertListing.alertNumber, alertNumbers));
  for (const p of stored) {
    products.set(p.listingId, [...(products.get(p.listingId) ?? []), productSignature(p)]);
    if (p.productCode) codes.set(p.listingId, (codes.get(p.listingId) ?? new Set()).add(p.productCode));
  }
  return { rows, products, codes };
}

/**
 * Syncs the Import Alert index, every food alert page and their Red/Green List firms (spec §6.3, §6.5).
 * Pages are read and parsed first, so a page-structure failure (saved under `failureDir`) fails the run before anything
 * is written. A listing missing from `MISSED_RUNS_TO_DELIST` consecutive successful runs is delisted.
 *
 * `rowsRead` is the number of listings parsed; `rowsInserted` and `rowsUpdated` count listings (a listing counts as
 * updated when anything but `last_seen_on` changed, including a missed-run count); nothing is deleted.
 * `only` limits the crawl to those alert numbers (manual checks).
 */
export async function syncImportAlerts(
  deps: SyncDeps & { failureDir: string },
  options: { events: boolean; only?: string[] },
): Promise<SyncRunResult> {
  return runSync(deps.db, 'import_alerts', async (ctx) => {
    const crawled = await crawl(deps, options.only);
    ctx.setOrigin(IMPORT_ALERT_INDEX_URL, crawled.indexSha256);
    const prepared = prepareListings(deps.rules, crawled.alerts);
    ctx.counts.rowsRead = prepared.length;
    const today = deps.today();
    const now = new Date();

    const counts = await deps.db.transaction(async (tx) => {
      // Alerts.
      for (const { entry, alert } of crawled.alerts) {
        const values = {
          title: alert.title,
          alertType: alert.alertType ?? entry.alertType,
          publishedOn: alert.publishedOn ?? entry.publishedOn,
          isFood: true,
          reasonText: alert.reasonText,
          guidanceText: alert.guidanceText,
          productText: alert.productText,
          chargeText: alert.chargeText,
          textSha256: alert.textSha256,
          url: entry.url,
          lastSeenAt: now,
          removedAt: null,
        };
        await tx.insert(importAlert).values({ number: alert.number, ...values }).onConflictDoUpdate({ target: importAlert.number, set: values });
      }

      // Food alerts that have left the index: mark them removed; their open listings count as missing.
      const absent = (
        await tx
          .select({ number: importAlert.number, removedAt: importAlert.removedAt })
          .from(importAlert)
          .where(and(eq(importAlert.isFood, true), notInArray(importAlert.number, [...crawled.foodNumbers])))
      );
      const newlyRemoved = absent.filter((row) => row.removedAt === null).map((row) => row.number);
      if (newlyRemoved.length > 0) await tx.update(importAlert).set({ removedAt: now }).where(inArray(importAlert.number, newlyRemoved));

      const fetchedNumbers = crawled.alerts.map(({ alert }) => alert.number);
      const existing = await loadExisting(tx, [...fetchedNumbers, ...absent.map((row) => row.number)]);
      const existingByKey = new Map(existing.rows.map((row) => [row.listingKey, row]));
      const seen = new Set(prepared.map((item) => item.key));

      const drafts: EventDraft[] = [];
      const inserts: PreparedListing[] = [];
      const touchOnly: number[] = [];
      const changed: { id: number; item: PreparedListing; set: Partial<ListingRow>; productsChanged: boolean }[] = [];

      for (const item of prepared) {
        const l = item.listing;
        const row = existingByKey.get(item.key);
        const red = l.list === 'red';
        const fallback = { commodityId: item.commodityId, hazardIds: item.hazardIds };
        if (!row) {
          inserts.push(item);
          if (red) drafts.push({ key: item.key, kind: 'import_alert_listed', occurredOn: l.listedOn ?? today, originCountry: l.countryCode, payload: { alertNumber: item.alertNumber }, fallback });
          continue;
        }

        const set: Partial<ListingRow> = {
          list: l.list,
          firmName: l.firmName,
          nameNorm: normalizeName(l.firmName).primary,
          addressRaw: l.addressRaw,
          city: l.city,
          region: l.region,
          countryCode: l.countryCode,
          listedOn: l.listedOn,
          missedRuns: 0,
          removedOn: null,
        };
        const newSignatures = l.products.map(productSignature);
        const productsChanged = !sameProducts(existing.products.get(row.id) ?? [], newSignatures);
        const dirty = (Object.keys(set) as (keyof ListingRow)[]).some((column) => set[column] !== row[column]) || productsChanged;
        if (dirty) changed.push({ id: row.id, item, set: { ...set, lastSeenOn: today }, productsChanged });
        else if (row.lastSeenOn !== today) touchOnly.push(row.id);

        const wasRed = row.list === 'red';
        const base = { key: item.key, occurredOn: l.listedOn ?? today, originCountry: l.countryCode, fallback };
        if (row.removedOn !== null) {
          if (red) drafts.push({ ...base, kind: 'import_alert_listed', payload: { alertNumber: item.alertNumber, relisted: true } });
        } else if (!wasRed && red) {
          drafts.push({ ...base, kind: 'import_alert_listed', payload: { alertNumber: item.alertNumber } });
        } else if (wasRed && !red) {
          drafts.push({ ...base, kind: 'import_alert_delisted', occurredOn: today, payload: { alertNumber: item.alertNumber, reason: 'moved to the Green List' } });
        } else if (wasRed && red) {
          const known = existing.codes.get(row.id) ?? new Set<string>();
          const newProducts = [...new Set(l.products.map((p) => p.productCode).filter((code): code is string => !!code && !known.has(code)))];
          if (newProducts.length > 0) drafts.push({ ...base, kind: 'import_alert_listed', payload: { alertNumber: item.alertNumber, newProducts } });
        }
      }

      // Open listings that were not seen in an alert this run read (or in an alert that left the index).
      const missed = existing.rows.filter((row) => row.removedOn === null && !seen.has(row.listingKey));
      const missedRemoved = missed.filter((row) => row.missedRuns + 1 >= MISSED_RUNS_TO_DELIST);
      const missedKept = missed.filter((row) => row.missedRuns + 1 < MISSED_RUNS_TO_DELIST);
      for (const row of missedRemoved) {
        if (row.list === 'red') {
          drafts.push({ key: row.listingKey, kind: 'import_alert_delisted', occurredOn: today, originCountry: row.countryCode, payload: { alertNumber: row.alertNumber, reason: 'missing from consecutive runs' } });
        }
      }

      // Listings.
      let rowsInserted = 0;
      const insertedIds = new Map<string, number>();
      for (const batch of chunks(inserts, BATCH_SIZE)) {
        const returned = await tx
          .insert(importAlertListing)
          .values(
            batch.map(({ key, alertNumber, listing: l }) => ({
              listingKey: key,
              alertNumber,
              list: l.list as AlertList,
              firmName: l.firmName,
              nameNorm: normalizeName(l.firmName).primary,
              addressRaw: l.addressRaw,
              city: l.city,
              region: l.region,
              countryCode: l.countryCode,
              listedOn: l.listedOn,
              firstSeenOn: today,
              lastSeenOn: today,
              missedRuns: 0,
            })),
          )
          .returning({ id: importAlertListing.id, key: importAlertListing.listingKey });
        for (const r of returned) insertedIds.set(r.key, r.id);
        rowsInserted += returned.length;
      }

      for (const batch of chunks(touchOnly, KEY_CHUNK)) {
        await tx.update(importAlertListing).set({ lastSeenOn: today }).where(inArray(importAlertListing.id, batch));
      }
      for (const { id, set } of changed) await tx.update(importAlertListing).set(set).where(eq(importAlertListing.id, id));
      for (const [rows, removing] of [[missedKept, false], [missedRemoved, true]] as const) {
        for (const batch of chunks(rows.map((row) => row.id), KEY_CHUNK)) {
          await tx
            .update(importAlertListing)
            .set(removing ? { missedRuns: sql`${importAlertListing.missedRuns} + 1`, removedOn: today } : { missedRuns: sql`${importAlertListing.missedRuns} + 1` })
            .where(inArray(importAlertListing.id, batch));
        }
      }

      // Products: replaced only where they changed.
      const replaceIds = changed.filter((c) => c.productsChanged).map((c) => c.id);
      for (const batch of chunks(replaceIds, KEY_CHUNK)) {
        await tx.delete(importAlertListingProduct).where(inArray(importAlertListingProduct.listingId, batch));
      }
      const productRows = [
        ...inserts.map((item) => ({ listingId: insertedIds.get(item.key) as number, products: item.listing.products })),
        ...changed.filter((c) => c.productsChanged).map((c) => ({ listingId: c.id, products: c.item.listing.products })),
      ].flatMap(({ listingId, products }) =>
        products.map((p) => ({ listingId, productCode: p.productCode, productName: p.productName, description: p.description, listedOn: p.listedOn, notes: p.notes })),
      );
      for (const batch of chunks(productRows, BATCH_SIZE)) await tx.insert(importAlertListingProduct).values(batch);

      // Notices: one per Red List listing.
      const firstSeen = new Map(existing.rows.map((row) => [row.listingKey, row.firstSeenOn]));
      const notices: NoticeInput[] = prepared
        .filter((item) => item.listing.list === 'red')
        .map((item) => {
          const l = item.listing;
          const names = l.products.map((p) => p.productName).filter((name): name is string => !!name);
          return {
            source: 'import_alert',
            sourceKey: item.key,
            noticeType: 'import_alert_listing',
            noticeOn: l.listedOn ?? firstSeen.get(item.key) ?? today,
            originCountry: l.countryCode,
            commodityId: item.commodityId,
            hazardIds: item.hazardIds,
            productText: names.length > 0 ? names.join('; ') : null,
            firmName: l.firmName,
            title: `${l.firmName} on Import Alert ${item.alertNumber}`,
            url: item.alertUrl,
          };
        });
      await upsertNotices(tx, notices);

      // Events.
      let eventsEmitted = 0;
      if (options.events && drafts.length > 0) {
        const stored = new Map<string, { id: number; commodityId: number | null; hazardIds: number[] }>();
        for (const batch of chunks([...new Set(drafts.map((d) => d.key))], KEY_CHUNK)) {
          const found = await tx
            .select({ id: notice.id, sourceKey: notice.sourceKey, commodityId: notice.commodityId, hazardIds: notice.hazardIds })
            .from(notice)
            .where(and(eq(notice.source, 'import_alert'), inArray(notice.sourceKey, batch)));
          for (const row of found) stored.set(row.sourceKey, row);
        }
        const events: EventInput[] = drafts.map((draft) => {
          const written = stored.get(draft.key);
          return {
            source: 'import_alert',
            sourceKey: draft.key,
            kind: draft.kind,
            occurredOn: draft.occurredOn,
            requiresFirm: true,
            originCountry: draft.originCountry,
            commodityId: written?.commodityId ?? draft.fallback?.commodityId ?? null,
            hazardIds: written?.hazardIds ?? draft.fallback?.hazardIds ?? [UNCLASSIFIED_ID],
            noticeId: written?.id ?? null,
            payload: draft.payload,
          };
        });
        eventsEmitted = await insertEvents(tx, events);
      }

      return { rowsInserted, rowsUpdated: changed.length + missed.length, eventsEmitted };
    });
    Object.assign(ctx.counts, counts);
  });
}
