import type { AlertList, NoticeSource } from '@rejectradar/contracts';
import {
  auFailingFood,
  fdaChargeCode,
  fdaRefusal,
  importAlert,
  importAlertListing,
  importAlertListingProduct,
  notice,
  rasffNotification,
  ukBorderNotification,
  type Database,
} from '@rejectradar/db';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { loadRuleSet } from '../core/rules';
import type { Tx } from '../core/sync-run';
import { classifyAu, type AuRecord } from './au-ifis/parse';
import { chargeCodeHazard } from './fda/charge-codes';
import { classifyRefusal, type RefusalRecord } from './fda/refusals';
import { classifyListing } from './import-alerts/sync';
import type { ParsedListing, ParsedListingProduct } from './import-alerts/parse-page';
import type { RasffHazard } from './rasff/parse';
import { classifyRasff } from './rasff/sync';
import { classifyUk } from './uk-bn/parse';

/** Rows read and rewritten per transaction. */
export const REMAP_BATCH_SIZE = 1000;

export type RemapCounts = Record<NoticeSource | 'fda_charge_code', number>;

interface Classification {
  commodityId: number;
  hazardIds: number[];
}

/** How one source is read, classified and written back; `Row` is a stored record, `Cursor` its key in read order. */
interface SourcePlan<Row, Cursor extends string | number> {
  /** The next `limit` rows after `after` (the first rows when null), in cursor order. */
  read(tx: Tx, after: Cursor | null, limit: number): Promise<Row[]>;
  cursor(row: Row): Cursor;
  classify(row: Row): Classification;
  /** What the row (or, for Import Alerts, its notice) holds now. */
  stored(row: Row): { commodityId: number | null; hazardIds: number[] };
  /** Writes the new classification to the source row; the notice is updated by the driver. Null when the source keeps it only on the notice. */
  write: ((tx: Tx, row: Row, result: Classification) => Promise<void>) | null;
  noticeKey(row: Row): string;
}

const sameClassification = (a: { commodityId: number | null; hazardIds: number[] }, b: Classification): boolean =>
  a.commodityId === b.commodityId && a.hazardIds.length === b.hazardIds.length && a.hazardIds.every((id, i) => id === b.hazardIds[i]);

/**
 * Walks one source in cursor order, `batchSize` rows per transaction. A row whose classification changed is updated
 * together with its notice in that transaction. Returns how many rows changed.
 */
async function remapSource<Row, Cursor extends string | number>(
  db: Database,
  source: NoticeSource,
  plan: SourcePlan<Row, Cursor>,
  batchSize: number,
): Promise<number> {
  let updated = 0;
  let after: Cursor | null = null;
  for (;;) {
    const batch: { size: number; last: Cursor | null; changed: number } = await db.transaction(async (tx) => {
      const rows = await plan.read(tx, after, batchSize);
      let changed = 0;
      for (const row of rows) {
        const result = plan.classify(row);
        if (sameClassification(plan.stored(row), result)) continue;
        await plan.write?.(tx, row, result);
        await tx
          .update(notice)
          .set({ commodityId: result.commodityId, hazardIds: result.hazardIds })
          .where(and(eq(notice.source, source), eq(notice.sourceKey, plan.noticeKey(row))));
        changed++;
      }
      return { size: rows.length, last: rows.length > 0 ? plan.cursor(rows[rows.length - 1]) : null, changed };
    });
    updated += batch.changed;
    if (batch.size < batchSize || batch.last === null) return updated;
    after = batch.last;
  }
}

/** Recomputes every charge code's hazard from the current rules; returns how many changed. */
async function remapChargeCodes(db: Database, rules: Awaited<ReturnType<typeof loadRuleSet>>, batchSize: number): Promise<number> {
  let updated = 0;
  let after: string | null = null;
  for (;;) {
    const batch: { size: number; last: string | null; changed: number } = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(fdaChargeCode)
        .where(after === null ? undefined : gt(fdaChargeCode.code, after))
        .orderBy(asc(fdaChargeCode.code))
        .limit(batchSize);
      let changed = 0;
      for (const row of rows) {
        const hazardId = chargeCodeHazard(rules, { name: row.name ?? '', description: row.description });
        if (hazardId === row.hazardId) continue;
        await tx.update(fdaChargeCode).set({ hazardId }).where(eq(fdaChargeCode.code, row.code));
        changed++;
      }
      return { size: rows.length, last: rows.length > 0 ? rows[rows.length - 1].code : null, changed };
    });
    updated += batch.changed;
    if (batch.size < batchSize || batch.last === null) return updated;
    after = batch.last;
  }
}

type ListingRow = {
  id: number;
  listingKey: string;
  list: string;
  firmName: string;
  addressRaw: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  listedOn: string | null;
  title: string;
  commodityId: number | null;
  hazardIds: number[];
  products: ParsedListingProduct[];
};

/** Reads the listings that have a notice (the Red List) with their current products in page order, as the sync saw them. */
async function readListings(tx: Tx, after: number | null, limit: number): Promise<ListingRow[]> {
  const listings = await tx
    .select({
      id: importAlertListing.id,
      listingKey: importAlertListing.listingKey,
      list: importAlertListing.list,
      firmName: importAlertListing.firmName,
      addressRaw: importAlertListing.addressRaw,
      city: importAlertListing.city,
      region: importAlertListing.region,
      countryCode: importAlertListing.countryCode,
      listedOn: importAlertListing.listedOn,
      title: importAlert.title,
      commodityId: notice.commodityId,
      hazardIds: notice.hazardIds,
    })
    .from(importAlertListing)
    .innerJoin(importAlert, eq(importAlert.number, importAlertListing.alertNumber))
    .innerJoin(notice, and(eq(notice.source, 'import_alert'), eq(notice.sourceKey, importAlertListing.listingKey)))
    .where(after === null ? eq(importAlertListing.list, 'red') : and(eq(importAlertListing.list, 'red'), gt(importAlertListing.id, after)))
    .orderBy(asc(importAlertListing.id))
    .limit(limit);
  if (listings.length === 0) return [];

  const products = await tx
    .select()
    .from(importAlertListingProduct)
    .where(
      and(
        inArray(
          importAlertListingProduct.listingId,
          listings.map((l) => l.id),
        ),
        isNull(importAlertListingProduct.removedOn),
      ),
    )
    .orderBy(asc(importAlertListingProduct.position), asc(importAlertListingProduct.id));
  const byListing = new Map<number, ParsedListingProduct[]>();
  for (const p of products) {
    const list = byListing.get(p.listingId) ?? [];
    list.push({
      productCode: p.productCode,
      industryCode: /^\d{2}/.exec(p.productCode ?? '')?.[0] ?? null,
      productName: p.productName,
      description: p.description,
      listedOn: p.listedOn,
      notes: p.notes,
      problems: p.problems,
    });
    byListing.set(p.listingId, list);
  }
  return listings.map((l) => ({ ...l, products: byListing.get(l.id) ?? [] }));
}

/** The `where` clause that skips everything up to and including `cursor`; none for the first batch. */
const pastCursor = <T>(cursor: T | null, make: (value: T) => ReturnType<typeof gt>) => (cursor === null ? undefined : make(cursor));

/**
 * Re-applies the current taxonomy rules to every stored record: FDA charge-code hazards first, then each source's
 * rows and their notices. It emits no change events and writes no `source_sync_run` row (it is not a source).
 * Returns how many rows changed per source; a second run with unchanged rules changes none.
 */
export async function remapTaxonomy(db: Database, options: { batchSize?: number } = {}): Promise<{ updated: RemapCounts }> {
  const batchSize = options.batchSize ?? REMAP_BATCH_SIZE;
  const rules = await loadRuleSet(db);
  const updated: RemapCounts = { fda_charge_code: 0, fda_refusal: 0, import_alert: 0, rasff: 0, uk_bn: 0, au_ifis: 0 };

  updated.fda_charge_code = await remapChargeCodes(db, rules, batchSize);

  const chargeHazards = new Map((await db.select({ code: fdaChargeCode.code, hazardId: fdaChargeCode.hazardId }).from(fdaChargeCode)).map((r) => [r.code, r.hazardId]));
  updated.fda_refusal = await remapSource<typeof fdaRefusal.$inferSelect, number>(
    db,
    'fda_refusal',
    {
      read: (tx, cursor, limit) =>
        tx.select().from(fdaRefusal).where(pastCursor(cursor, (id) => gt(fdaRefusal.id, id))).orderBy(asc(fdaRefusal.id)).limit(limit),
      cursor: (row) => row.id,
      classify: (row) => {
        const record: RefusalRecord = {
          sourceKey: row.sourceKey,
          fei: row.fei,
          firmName: row.firmName,
          nameNorm: row.nameNorm,
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2,
          city: row.city,
          region: row.region,
          postalCode: row.postalCode,
          countryCode: row.countryCode,
          divisionCode: row.divisionCode,
          industryCode: row.industryCode,
          productCode: row.productCode,
          productDesc: row.productDesc,
          productCategory: row.productCategory ?? '',
          refusalDate: row.refusalDate,
          chargeCodes: row.chargeCodes,
          fdaSampleAnalysis: row.fdaSampleAnalysis,
          privateLabAnalysis: row.privateLabAnalysis,
          firmProfile: null,
        };
        return classifyRefusal(rules, chargeHazards, record);
      },
      stored: (row) => row,
      write: async (tx, row, result) => {
        await tx.update(fdaRefusal).set({ commodityId: result.commodityId, hazardIds: result.hazardIds }).where(eq(fdaRefusal.id, row.id));
      },
      noticeKey: (row) => row.sourceKey,
    },
    batchSize,
  );

  updated.import_alert = await remapSource<ListingRow, number>(
    db,
    'import_alert',
    {
      read: readListings,
      cursor: (row) => row.id,
      classify: (row) => {
        const listing: ParsedListing = {
          list: row.list as AlertList,
          firmName: row.firmName,
          addressRaw: row.addressRaw,
          city: row.city,
          region: row.region,
          countryCode: row.countryCode,
          countryName: '',
          listedOn: row.listedOn,
          products: row.products,
        };
        return classifyListing(rules, { title: row.title }, listing);
      },
      stored: (row) => row,
      // An Import Alert listing keeps no classification of its own; only its notice carries one.
      write: null,
      noticeKey: (row) => row.listingKey,
    },
    batchSize,
  );

  updated.rasff = await remapSource<typeof rasffNotification.$inferSelect, string>(
    db,
    'rasff',
    {
      read: (tx, cursor, limit) =>
        tx.select().from(rasffNotification).where(pastCursor(cursor, (key) => gt(rasffNotification.reference, key))).orderBy(asc(rasffNotification.reference)).limit(limit),
      cursor: (row) => row.reference,
      classify: (row) => classifyRasff(rules, { productCategory: row.productCategory, subject: row.subject }, row.hazards as RasffHazard[]),
      stored: (row) => row,
      write: async (tx, row, result) => {
        await tx.update(rasffNotification).set({ commodityId: result.commodityId, hazardIds: result.hazardIds }).where(eq(rasffNotification.reference, row.reference));
      },
      noticeKey: (row) => row.reference,
    },
    batchSize,
  );

  updated.uk_bn = await remapSource<typeof ukBorderNotification.$inferSelect, string>(
    db,
    'uk_bn',
    {
      read: (tx, cursor, limit) =>
        tx.select().from(ukBorderNotification).where(pastCursor(cursor, (key) => gt(ukBorderNotification.sourceKey, key))).orderBy(asc(ukBorderNotification.sourceKey)).limit(limit),
      cursor: (row) => row.sourceKey,
      classify: (row) => classifyUk(rules, row),
      stored: (row) => row,
      write: async (tx, row, result) => {
        await tx.update(ukBorderNotification).set({ commodityId: result.commodityId, hazardIds: result.hazardIds }).where(eq(ukBorderNotification.sourceKey, row.sourceKey));
      },
      noticeKey: (row) => row.sourceKey,
    },
    batchSize,
  );

  updated.au_ifis = await remapSource<typeof auFailingFood.$inferSelect, number>(
    db,
    'au_ifis',
    {
      read: (tx, cursor, limit) =>
        tx.select().from(auFailingFood).where(pastCursor(cursor, (id) => gt(auFailingFood.id, id))).orderBy(asc(auFailingFood.id)).limit(limit),
      cursor: (row) => row.id,
      classify: (row) => {
        const record: AuRecord = {
          sourceKey: row.sourceKey,
          reportMonth: row.reportMonth,
          failedOn: row.failedOn,
          productDesc: row.productDesc,
          countryCode: row.countryCode,
          countryName: row.countryName,
          producerName: row.producerName,
          nameNorm: row.nameNorm,
          testApplied: row.testApplied ?? '',
          reason: row.reason ?? '',
          resultText: row.resultText,
          holdingOrderMatch: row.holdingOrderMatch,
          scheme: row.scheme as AuRecord['scheme'],
        };
        return classifyAu(rules, record);
      },
      stored: (row) => row,
      write: async (tx, row, result) => {
        await tx.update(auFailingFood).set({ commodityId: result.commodityId, hazardIds: result.hazardIds }).where(eq(auFailingFood.id, row.id));
      },
      noticeKey: (row) => row.sourceKey,
    },
    batchSize,
  );

  return { updated };
}
