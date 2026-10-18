import type { AlertList, EventKind } from '@rejectradar/contracts';
import { importAlert, importAlertListing, importAlertListingProduct, notice } from '@rejectradar/db';
import { normalizeName } from '@rejectradar/matching';
import { classifyCommodity, classifyHazards, UNCLASSIFIED_ID, type RuleSet } from '@rejectradar/taxonomy';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SyncDeps } from '../../core/deps';
import { insertEvents, upsertNotices, type EventInput, type NoticeInput } from '../../core/notices';
import { eventsForRun, runSync, type SyncRunResult, type Tx } from '../../core/sync-run';
import { canonical } from './identity';
import { isFoodAlert, parseAlertIndex, type AlertIndexEntry } from './parse-index';
import { PageStructureError, parseAlertPage, type ParsedAlert, type ParsedListing, type ParsedListingProduct } from './parse-page';

export const IMPORT_ALERT_INDEX_URL = 'https://www.accessdata.fda.gov/cms_ia/ialist.html';

/** FDA robots.txt `Visiting-hours: 23:00-05:00 EDT`, as UTC hours: a full crawl starts at or after 03:00 and before 09:00. */
export const VISITING_HOURS_UTC = { from: 3, to: 9 } as const;

/**
 * Refuses a full crawl (no `only`) outside the visiting hours unless `forceHours` is set. Scheduled, dispatched and
 * backfill runs pass neither flag, so they are guarded too.
 */
export function assertVisitingHours(now: Date, options: { only?: string[]; forceHours?: boolean }): void {
  if (options.only !== undefined || options.forceHours) return;
  const hour = now.getUTCHours();
  if (hour >= VISITING_HOURS_UTC.from && hour < VISITING_HOURS_UTC.to) return;
  const time = now.toISOString().slice(11, 16);
  throw new Error(
    `sync:import-alerts crawls www.accessdata.fda.gov only inside its robots.txt visiting hours, 03:00-09:00 UTC; it is ${time} UTC now. ` +
      'Pass --force-hours to run anyway, or --only <numbers> for a manual check of a few alerts.',
  );
}

/** A listing that is missing from this many consecutive successful runs is delisted (spec §6.5). */
export const MISSED_RUNS_TO_DELIST = 2;

const BATCH_SIZE = 500;
const KEY_CHUNK = 5000;

/**
 * Identity of a listing: the alert, the firm name, the country heading and the address, each as raw page text in its
 * frozen {@link canonical} form. It never uses `@rejectradar/matching` (the stored `name_norm` and `country_code` are for
 * linking and may change with it), so a better normaliser can never change a key.
 */
export function listingKey(alertNumber: string, l: ParsedListing): string {
  const parts = [alertNumber, canonical(l.firmName), canonical(l.countryName), canonical(l.addressRaw ?? '')];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

/** The re-key identity: the alert, the canonical raw firm name and the canonical raw country heading. */
const rekeyIdentity = (alertNumber: string, firmName: string, countryName: string | null): string =>
  JSON.stringify([alertNumber, canonical(firmName), canonical(countryName ?? '')]);

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
  /** Every alert in the index, food or not. */
  indexNumbers: Set<string>;
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
  return { indexSha256: index.sha256, indexNumbers: new Set(entries.map((entry) => entry.number)), foodNumbers: new Set(food.map((entry) => entry.number)), alerts };
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

/**
 * One entry per listing key. FDA repeats some firm blocks verbatim (merged, identical products kept once). When the
 * blocks of one key disagree on the list, the Red List wins and the merged listing keeps only the red blocks' products,
 * so a product that is only Green-listed never shows up as newly Red-listed.
 */
function prepareListings(rules: RuleSet, crawled: Crawl['alerts']): PreparedListing[] {
  const groups = new Map<string, { entry: AlertIndexEntry; alert: ParsedAlert; blocks: ParsedListing[] }>();
  for (const { entry, alert } of crawled) {
    for (const listing of alert.listings) {
      const key = listingKey(alert.number, listing);
      const group = groups.get(key);
      if (group) group.blocks.push(listing);
      else groups.set(key, { entry, alert, blocks: [listing] });
    }
  }
  return [...groups.entries()].map(([key, { entry, alert, blocks }]) => {
    const red = blocks.filter((block) => block.list === 'red');
    const used = red.length > 0 ? red : blocks;
    const listing: ParsedListing = { ...used[0], products: used.reduce<ParsedListingProduct[]>((all, block) => mergeProducts(all, block.products), []) };
    return { key, alertNumber: alert.number, alertTitle: alert.title, alertUrl: entry.url, listing, ...classifyListing(rules, alert, listing) };
  });
}

const productSignature = (p: Pick<ParsedListingProduct, 'productCode' | 'productName' | 'description' | 'listedOn' | 'notes'>): string =>
  JSON.stringify([p.productCode, p.productName, p.description, p.listedOn, p.notes]);

type ListingRow = typeof importAlertListing.$inferSelect;

interface EventDraft {
  key: string;
  kind: Extract<EventKind, 'import_alert_listed' | 'import_alert_delisted'>;
  occurredOn: string;
  originCountry: string | null;
  payload: Record<string, unknown>;
  fallback?: { commodityId: number; hazardIds: number[] };
}

type StoredProduct = Pick<typeof importAlertListingProduct.$inferSelect, 'id' | 'listingId' | 'productCode' | 'productName' | 'description' | 'listedOn' | 'notes' | 'problems' | 'position' | 'removedOn'>;

/** Products of one listing keyed by code (or name when there is no code) plus an ordinal for repeated codes. */
function identify<T extends { productCode: string | null; productName: string | null }>(items: readonly T[]): Map<string, T> {
  const seen = new Map<string, number>();
  const out = new Map<string, T>();
  for (const item of items) {
    const base = item.productCode ?? `~${item.productName ?? ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(`${base}#${n}`, item);
  }
  return out;
}

async function loadExisting(
  tx: Tx,
  alertNumbers: string[],
): Promise<{ rows: ListingRow[]; products: Map<number, StoredProduct[]>; codes: Map<number, Set<string>> }> {
  const rows: ListingRow[] = [];
  const products = new Map<number, StoredProduct[]>();
  const codes = new Map<number, Set<string>>();
  if (alertNumbers.length === 0) return { rows, products, codes };
  rows.push(...(await tx.select().from(importAlertListing).where(inArray(importAlertListing.alertNumber, alertNumbers))));
  const stored = await tx
    .select({
      id: importAlertListingProduct.id,
      listingId: importAlertListingProduct.listingId,
      productCode: importAlertListingProduct.productCode,
      productName: importAlertListingProduct.productName,
      description: importAlertListingProduct.description,
      listedOn: importAlertListingProduct.listedOn,
      notes: importAlertListingProduct.notes,
      problems: importAlertListingProduct.problems,
      position: importAlertListingProduct.position,
      removedOn: importAlertListingProduct.removedOn,
    })
    .from(importAlertListingProduct)
    .innerJoin(importAlertListing, eq(importAlertListing.id, importAlertListingProduct.listingId))
    .where(inArray(importAlertListing.alertNumber, alertNumbers))
    .orderBy(importAlertListingProduct.id);
  for (const p of stored) {
    products.set(p.listingId, [...(products.get(p.listingId) ?? []), p]);
    // A code that was ever stored for the listing is not "new" when it returns, whether or not it is currently removed.
    if (p.productCode) codes.set(p.listingId, (codes.get(p.listingId) ?? new Set()).add(p.productCode));
  }
  return { rows, products, codes };
}

interface ProductPlan {
  inserts: { product: ParsedListingProduct; position: number }[];
  updates: { id: number; set: Partial<StoredProduct> }[];
  removals: number[];
}

/** Compares the page's products with the stored ones: new ones are inserted, changed or returning ones updated in place, vanished ones marked removed. */
function planProducts(stored: readonly StoredProduct[], parsed: readonly ParsedListingProduct[]): ProductPlan {
  const plan: ProductPlan = { inserts: [], updates: [], removals: [] };
  const known = identify(stored);
  const current = identify(parsed);
  const positionOf = new Map(parsed.map((p, i) => [p, i]));
  for (const [ident, p] of current) {
    const position = positionOf.get(p) as number;
    const row = known.get(ident);
    if (!row) {
      plan.inserts.push({ product: p, position });
      continue;
    }
    const set: Partial<StoredProduct> = {};
    if (row.productName !== p.productName) set.productName = p.productName;
    if (row.description !== p.description) set.description = p.description;
    if (row.listedOn !== p.listedOn) set.listedOn = p.listedOn;
    if (row.notes !== p.notes) set.notes = p.notes;
    if (row.problems.length !== p.problems.length || row.problems.some((problem, i) => problem !== p.problems[i])) set.problems = p.problems;
    if (row.position !== position) set.position = position;
    if (row.removedOn !== null) set.removedOn = null;
    if (Object.keys(set).length > 0) plan.updates.push({ id: row.id, set });
  }
  for (const [ident, row] of known) {
    if (!current.has(ident) && row.removedOn === null) plan.removals.push(row.id);
  }
  return plan;
}

/**
 * Syncs the Import Alert index, every food alert page and their Red/Green List firms (spec §6.3, §6.5).
 * Pages are read and parsed first, so a page-structure failure (saved under `failureDir`) fails the run before anything
 * is written. A listing missing from `MISSED_RUNS_TO_DELIST` consecutive successful runs is delisted.
 *
 * `rowsRead` is the number of listings parsed; `rowsInserted` and `rowsUpdated` count listings (a listing counts as
 * updated when anything but `last_seen_on` changed, including a missed-run count); nothing is deleted.
 * `only` limits the crawl to those alert numbers (manual checks). Without it the run refuses to start outside the
 * visiting hours unless `forceHours` is set (see {@link assertVisitingHours}); `now` is injectable for tests.
 */
export async function syncImportAlerts(
  deps: SyncDeps & { failureDir: string; now?: () => Date },
  options: { events: boolean; only?: string[]; forceHours?: boolean },
): Promise<SyncRunResult> {
  assertVisitingHours((deps.now ?? (() => new Date()))(), options);
  return runSync(deps.db, 'import_alerts', async (ctx) => {
    const emitEvents = await eventsForRun(deps.db, 'import_alerts', options.events);
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

      // Food alerts that have left the index are marked removed and their open listings count as missing. An alert
      // that is still indexed but no longer passes the food filter is only flagged `is_food = false`: it is not
      // removed and its listings are not counted as missed.
      const notFood = await tx
        .select({ number: importAlert.number, removedAt: importAlert.removedAt })
        .from(importAlert)
        .where(and(eq(importAlert.isFood, true), notInArray(importAlert.number, [...crawled.foodNumbers])));
      const absent = notFood.filter((row) => !crawled.indexNumbers.has(row.number));
      const flipped = notFood.filter((row) => crawled.indexNumbers.has(row.number)).map((row) => row.number);
      if (flipped.length > 0) await tx.update(importAlert).set({ isFood: false }).where(inArray(importAlert.number, flipped));
      const newlyRemoved = absent.filter((row) => row.removedAt === null).map((row) => row.number);
      if (newlyRemoved.length > 0) await tx.update(importAlert).set({ removedAt: now }).where(inArray(importAlert.number, newlyRemoved));

      const fetchedNumbers = crawled.alerts.map(({ alert }) => alert.number);
      const existing = await loadExisting(tx, [...fetchedNumbers, ...absent.map((row) => row.number)]);
      const existingByKey = new Map(existing.rows.map((row) => [row.listingKey, row]));
      const seen = new Set(prepared.map((item) => item.key));

      // A new key whose alert, raw firm name and raw country heading (canonical forms) match exactly one open, unseen
      // listing (and no other new key does) is that listing with an edited address: re-key it instead of delisting one
      // and listing another. Stored `name_norm` / `country_code` are not used, so normaliser changes cannot break this.
      const newItems = new Map<string, PreparedListing[]>();
      for (const item of prepared) {
        if (existingByKey.has(item.key)) continue;
        const id = rekeyIdentity(item.alertNumber, item.listing.firmName, item.listing.countryName);
        newItems.set(id, [...(newItems.get(id) ?? []), item]);
      }
      const candidates = new Map<string, ListingRow[]>();
      for (const row of existing.rows) {
        if (row.removedOn !== null || seen.has(row.listingKey)) continue;
        const id = rekeyIdentity(row.alertNumber, row.firmName, row.countryName);
        candidates.set(id, [...(candidates.get(id) ?? []), row]);
      }
      const rekeyed = new Map<string, ListingRow>();
      for (const [id, items] of newItems) {
        const rows = candidates.get(id) ?? [];
        if (items.length === 1 && rows.length === 1) rekeyed.set(items[0].key, rows[0]);
      }
      const rekeyedIds = new Set([...rekeyed.values()].map((row) => row.id));

      const drafts: EventDraft[] = [];
      const inserts: PreparedListing[] = [];
      const touchOnly: number[] = [];
      const changed: { id: number; set: Partial<ListingRow> }[] = [];
      const productInserts: { listingId: number; product: ParsedListingProduct; position: number }[] = [];
      const productUpdates: ProductPlan['updates'] = [];
      const productRemovals: number[] = [];

      for (const item of prepared) {
        const l = item.listing;
        const isRekey = rekeyed.has(item.key);
        const row = existingByKey.get(item.key) ?? rekeyed.get(item.key);
        const red = l.list === 'red';
        const fallback = { commodityId: item.commodityId, hazardIds: item.hazardIds };
        if (!row) {
          inserts.push(item);
          if (red) drafts.push({ key: item.key, kind: 'import_alert_listed', occurredOn: l.listedOn ?? today, originCountry: l.countryCode, payload: { alertNumber: item.alertNumber }, fallback });
          continue;
        }

        const set: Partial<ListingRow> = {
          listingKey: item.key,
          list: l.list,
          firmName: l.firmName,
          nameNorm: normalizeName(l.firmName).primary,
          addressRaw: l.addressRaw,
          city: l.city,
          region: l.region,
          countryCode: l.countryCode,
          countryName: l.countryName,
          listedOn: l.listedOn,
          missedRuns: 0,
          removedOn: null,
        };
        const plan = planProducts(existing.products.get(row.id) ?? [], l.products);
        const productsChanged = plan.inserts.length + plan.updates.length + plan.removals.length > 0;
        productInserts.push(...plan.inserts.map(({ product, position }) => ({ listingId: row.id, product, position })));
        productUpdates.push(...plan.updates);
        productRemovals.push(...plan.removals);
        const dirty = (Object.keys(set) as (keyof ListingRow)[]).some((column) => set[column] !== row[column]) || productsChanged;
        if (dirty) changed.push({ id: row.id, set: { ...set, lastSeenOn: today } });
        else if (row.lastSeenOn !== today) touchOnly.push(row.id);

        const wasRed = row.list === 'red';
        const base = { key: item.key, occurredOn: l.listedOn ?? today, originCountry: l.countryCode, fallback };
        if (row.removedOn !== null) {
          if (red) drafts.push({ ...base, kind: 'import_alert_listed', payload: { alertNumber: item.alertNumber, relisted: true } });
        } else if (!wasRed && red) {
          drafts.push({ ...base, kind: 'import_alert_listed', payload: { alertNumber: item.alertNumber } });
        } else if (wasRed && !red) {
          drafts.push({ ...base, kind: 'import_alert_delisted', occurredOn: today, payload: { alertNumber: item.alertNumber, reason: 'moved to the Green List' } });
        } else if (wasRed && red && !isRekey) {
          // Only a code never stored for this listing is new; one that dropped out and came back is not.
          const known = existing.codes.get(row.id) ?? new Set<string>();
          const newProducts = [...new Set(l.products.map((p) => p.productCode).filter((code): code is string => !!code && !known.has(code)))];
          if (newProducts.length > 0) drafts.push({ ...base, kind: 'import_alert_listed', payload: { alertNumber: item.alertNumber, newProducts } });
        }
      }

      // Open listings that were not seen in an alert this run read (or in an alert that left the index).
      const missed = existing.rows.filter((row) => row.removedOn === null && !seen.has(row.listingKey) && !rekeyedIds.has(row.id));
      const missedRemoved = missed.filter((row) => row.missedRuns + 1 >= MISSED_RUNS_TO_DELIST);
      const missedKept = missed.filter((row) => row.missedRuns + 1 < MISSED_RUNS_TO_DELIST);
      for (const row of missedRemoved) {
        if (row.list === 'red') {
          drafts.push({ key: row.listingKey, kind: 'import_alert_delisted', occurredOn: today, originCountry: row.countryCode, payload: { alertNumber: row.alertNumber, reason: 'missing from consecutive runs' } });
        }
      }

      // A re-keyed listing keeps its notice: move the notice to the new key before the notices are upserted.
      for (const [newKey, row] of rekeyed) {
        await tx.update(notice).set({ sourceKey: newKey }).where(and(eq(notice.source, 'import_alert'), eq(notice.sourceKey, row.listingKey)));
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
              countryName: l.countryName,
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

      // Products are never deleted: a vanished code gets `removed_on`, a returning one has it cleared, a code never stored is inserted.
      for (const { id, set } of productUpdates) await tx.update(importAlertListingProduct).set(set).where(eq(importAlertListingProduct.id, id));
      for (const batch of chunks(productRemovals, KEY_CHUNK)) {
        await tx.update(importAlertListingProduct).set({ removedOn: today }).where(inArray(importAlertListingProduct.id, batch));
      }
      const productRows = [
        ...inserts.flatMap((item) => item.listing.products.map((product, position) => ({ listingId: insertedIds.get(item.key) as number, product, position }))),
        ...productInserts,
      ].map(({ listingId, product: p, position }) => ({
        listingId,
        productCode: p.productCode,
        productName: p.productName,
        description: p.description,
        listedOn: p.listedOn,
        notes: p.notes,
        problems: p.problems,
        position,
      }));
      for (const batch of chunks(productRows, BATCH_SIZE)) await tx.insert(importAlertListingProduct).values(batch);

      // Notices: one per Red List listing.
      const firstSeen = new Map([...existing.rows.map((row) => [row.listingKey, row.firstSeenOn] as const), ...[...rekeyed].map(([key, row]) => [key, row.firstSeenOn] as const)]);
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
      if (emitEvents && drafts.length > 0) {
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
