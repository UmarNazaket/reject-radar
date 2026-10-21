import { auFailingFood, fdaRefusal, firm, firmAlias, firmFei, importAlertListing, notice } from '@rejectradar/db';
import { normalizeAddress, type NormalizedAddress, stripLocationTail } from '@rejectradar/matching';
import { and, asc, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { DbOrTx, FirmRecord, KnownFirm } from './types';

/** A stored record that names a firm: the engine's view of it, the firm it is linked to and its address as written. */
export interface LoadedRecord {
  record: FirmRecord;
  /** null while the record is unlinked. */
  firmId: number | null;
  /** The address as the source writes it, for a person to read; null when the source gives none. */
  rawAddress: string | null;
}

interface LoadOptions {
  /** Linked records too, not only the unlinked ones. */
  includeLinked: boolean;
}

/**
 * What a linking run starts from: every firm that can still receive records, and every unlinked record that names a
 * firm. Firms come by id; records by source (FDA, Import Alert, Australia), each in the order its rows were stored.
 */
export async function loadLinkInput(db: DbOrTx): Promise<{ firms: KnownFirm[]; records: FirmRecord[] }> {
  const firms = await loadFirms(db);
  const records = (await loadFirmRecords(db, { includeLinked: false })).map(({ record }) => record);
  return { firms, records };
}

/**
 * Every record that names a firm, unlinked only unless `includeLinked`: by source (FDA, Import Alert, Australia), each
 * in the order its rows were stored.
 */
export async function loadFirmRecords(db: DbOrTx, opts: LoadOptions): Promise<LoadedRecord[]> {
  return [...(await loadRefusals(db, opts)), ...(await loadListings(db, opts)), ...(await loadAuRows(db, opts))];
}

/** The firms not merged away (P3-D9), by ascending id, each with the FEIs it holds, ascending. */
export async function loadFirms(db: DbOrTx): Promise<KnownFirm[]> {
  const rows = await db
    .select({
      id: firm.id,
      nameNorm: firm.nameNorm,
      commodityIds: firm.commodityIds,
      countryCode: firm.countryCode,
      region: firm.region,
      city: firm.city,
      postalCode: firm.postalCode,
      addressNorm: firm.addressNorm,
    })
    .from(firm)
    .where(notInArray(firm.id, db.select({ id: firmAlias.oldId }).from(firmAlias)))
    .orderBy(asc(firm.id));
  const feis = new Map<number, number[]>();
  for (const { fei, firmId } of await db.select().from(firmFei).orderBy(asc(firmFei.fei))) {
    const held = feis.get(firmId);
    if (held) held.push(fei);
    else feis.set(firmId, [fei]);
  }
  return rows.map(({ id, nameNorm, commodityIds, ...address }) => ({
    id,
    nameNorm,
    address: storedAddress(address),
    commodityIds,
    feis: feis.get(id) ?? [],
  }));
}

/** A firm's address columns were normalised when it was written, so they are taken as they are; null when all are. */
function storedAddress(columns: NormalizedAddress): NormalizedAddress | null {
  return Object.values(columns).some((value) => value !== null) ? columns : null;
}

const commodityIdsOf = (commodityId: number | null): number[] => (commodityId === null ? [] : [commodityId]);

/** FDA refusals. The address comes in fields, which a person reads joined by commas. */
async function loadRefusals(db: DbOrTx, { includeLinked }: LoadOptions): Promise<LoadedRecord[]> {
  const rows = await db
    .select({
      key: fdaRefusal.sourceKey,
      fei: fdaRefusal.fei,
      firmName: fdaRefusal.firmName,
      nameNorm: fdaRefusal.nameNorm,
      addressLine1: fdaRefusal.addressLine1,
      addressLine2: fdaRefusal.addressLine2,
      city: fdaRefusal.city,
      region: fdaRefusal.region,
      postalCode: fdaRefusal.postalCode,
      countryCode: fdaRefusal.countryCode,
      commodityId: fdaRefusal.commodityId,
      seenOn: fdaRefusal.refusalDate,
      firmId: fdaRefusal.firmId,
    })
    .from(fdaRefusal)
    .where(includeLinked ? undefined : isNull(fdaRefusal.firmId))
    .orderBy(asc(fdaRefusal.id));
  return rows.map((row) => ({
    record: {
      source: 'fda_refusal',
      key: row.key,
      fei: row.fei,
      firmName: row.firmName,
      nameNorm: row.nameNorm,
      address: normalizeAddress({
        line1: row.addressLine1,
        line2: row.addressLine2,
        city: row.city,
        region: row.region,
        postalCode: row.postalCode,
        country: row.countryCode,
      }),
      commodityIds: commodityIdsOf(row.commodityId),
      seenOn: row.seenOn,
    },
    firmId: row.firmId,
    rawAddress:
      [row.addressLine1, row.addressLine2, row.city, row.region, row.postalCode]
        .filter((part) => part?.trim())
        .join(', ') || null,
  }));
}

/**
 * Import Alert listings. `address_raw` ends in the city, region and country (P3-D3), which are cut off against the
 * country as the page writes it, before the address is normalised. Only a Red List listing has a notice, which holds
 * its commodity.
 */
async function loadListings(db: DbOrTx, { includeLinked }: LoadOptions): Promise<LoadedRecord[]> {
  const rows = await db
    .select({
      key: importAlertListing.listingKey,
      firmName: importAlertListing.firmName,
      nameNorm: importAlertListing.nameNorm,
      addressRaw: importAlertListing.addressRaw,
      city: importAlertListing.city,
      region: importAlertListing.region,
      countryCode: importAlertListing.countryCode,
      countryName: importAlertListing.countryName,
      commodityId: notice.commodityId,
      seenOn: sql<string>`coalesce(${importAlertListing.listedOn}, ${importAlertListing.firstSeenOn})`,
      firmId: importAlertListing.firmId,
    })
    .from(importAlertListing)
    .leftJoin(notice, and(eq(notice.source, 'import_alert'), eq(notice.sourceKey, importAlertListing.listingKey)))
    .where(includeLinked ? undefined : isNull(importAlertListing.firmId))
    .orderBy(asc(importAlertListing.id));
  return rows.map((row) => ({
    record: {
      source: 'import_alert',
      key: row.key,
      fei: null,
      firmName: row.firmName,
      nameNorm: row.nameNorm,
      address: normalizeAddress({
        line1:
          row.addressRaw === null
            ? null
            : stripLocationTail(row.addressRaw, { city: row.city, region: row.region, country: row.countryName }),
        city: row.city,
        region: row.region,
        country: row.countryCode,
      }),
      commodityIds: commodityIdsOf(row.commodityId),
      seenOn: row.seenOn,
    },
    firmId: row.firmId,
    rawAddress: row.addressRaw,
  }));
}

/** Australian failed tests that name a producer; the file gives only the producer's country. */
async function loadAuRows(db: DbOrTx, { includeLinked }: LoadOptions): Promise<LoadedRecord[]> {
  const rows = await db
    .select({
      key: auFailingFood.sourceKey,
      producerName: auFailingFood.producerName,
      nameNorm: auFailingFood.nameNorm,
      countryCode: auFailingFood.countryCode,
      commodityId: auFailingFood.commodityId,
      seenOn: sql<string>`coalesce(${auFailingFood.failedOn}, ${auFailingFood.reportMonth})`,
      firmId: auFailingFood.firmId,
    })
    .from(auFailingFood)
    .where(and(includeLinked ? undefined : isNull(auFailingFood.firmId), ne(auFailingFood.nameNorm, '')))
    .orderBy(asc(auFailingFood.id));
  // name_norm is '' whenever there is no producer, so this only tells the compiler the name is there.
  return rows.flatMap(({ key, producerName, nameNorm, countryCode, commodityId, seenOn, firmId }) =>
    producerName === null
      ? []
      : [
          {
            record: {
              source: 'au_ifis',
              key,
              fei: null,
              firmName: producerName,
              nameNorm,
              address: normalizeAddress({ country: countryCode }),
              commodityIds: commodityIdsOf(commodityId),
              seenOn,
            },
            firmId,
            rawAddress: null,
          },
        ],
  );
}
