import { auFailingFood, fdaRefusal, firm, firmAlias, firmFei, importAlertListing, notice } from '@rejectradar/db';
import { normalizeAddress, type NormalizedAddress, type RawAddress, stripLocationTail } from '@rejectradar/matching';
import { and, asc, eq, isNotNull, isNull, ne, notInArray, type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { DbOrTx, FirmRecord, FrequencyName, KnownFirm } from './types';

/** A stored record that names a firm: the engine's view of it, the firm it is linked to and its address as written. */
export interface LoadedRecord {
  record: FirmRecord;
  /** null while the record is unlinked. */
  firmId: number | null;
  /** The address as the source writes it, for a person to read; null when the source gives none. */
  rawAddress: string | null;
}

/** Which records to load: the unlinked ones, the linked ones too (`includeLinked`), or those of one firm. */
type LoadOptions = { includeLinked: boolean } | { firmId: number };

/** The condition on a source's `firm_id` column that picks the records `opts` asks for. */
function whichRecords(opts: LoadOptions, firmId: PgColumn): SQL | undefined {
  if ('firmId' in opts) return eq(firmId, opts.firmId);
  return opts.includeLinked ? undefined : isNull(firmId);
}

/**
 * What a linking run starts from: every firm that can still receive records, every unlinked record that names a firm,
 * and the names whose tokens tell a distinctive name (loadFrequencyNames). Firms come by id; records by source (FDA,
 * Import Alert, Australia), each in the order its rows were stored.
 */
export async function loadLinkInput(
  db: DbOrTx,
): Promise<{ firms: KnownFirm[]; records: FirmRecord[]; frequencyNames: FrequencyName[] }> {
  const firms = await loadFirms(db);
  const records = (await loadFirmRecords(db, { includeLinked: false })).map(({ record }) => record);
  return { firms, records, frequencyNames: await loadFrequencyNames(db) };
}

/** The firms merged away (P3-D9), which keep their rows behind a `firm_alias`. */
const mergedAway = (db: DbOrTx) => db.select({ id: firmAlias.oldId }).from(firmAlias);

/**
 * P3-D4: the names whose tokens tell a distinctive name, the same for every run and for the sampler. Each distinct
 * `country_code` and `name_norm` of every firm-level record, linked or not (FDA refusals, Import Alert listings and the
 * Australian failed tests that name a producer), and of every firm not merged away. A name without a country counts in
 * no country, so it is left out. In no particular order: the counts don't depend on it.
 */
export async function loadFrequencyNames(db: DbOrTx): Promise<FrequencyName[]> {
  const refusals = db
    .select({ countryCode: fdaRefusal.countryCode, nameNorm: fdaRefusal.nameNorm })
    .from(fdaRefusal)
    .where(isNotNull(fdaRefusal.countryCode));
  const listings = db
    .select({ countryCode: importAlertListing.countryCode, nameNorm: importAlertListing.nameNorm })
    .from(importAlertListing)
    .where(isNotNull(importAlertListing.countryCode));
  const auRows = db
    .select({ countryCode: auFailingFood.countryCode, nameNorm: auFailingFood.nameNorm })
    .from(auFailingFood)
    .where(and(isNotNull(auFailingFood.countryCode), ne(auFailingFood.nameNorm, '')));
  const firms = db
    .select({ countryCode: firm.countryCode, nameNorm: firm.nameNorm })
    .from(firm)
    .where(and(isNotNull(firm.countryCode), notInArray(firm.id, mergedAway(db))));
  // `union` keeps each country and name once.
  return refusals.union(listings).union(auRows).union(firms);
}

/**
 * Every record that names a firm, unlinked only unless `includeLinked`, or only those of `firmId`: by source (FDA,
 * Import Alert, Australia), each in the order its rows were stored.
 */
export async function loadFirmRecords(db: DbOrTx, opts: LoadOptions): Promise<LoadedRecord[]> {
  return [...(await loadRefusals(db, opts)), ...(await loadListings(db, opts)), ...(await loadAuRows(db, opts))];
}

/**
 * The firms not merged away (P3-D9), by ascending id, each with the FEIs it holds, ascending. A merge moves the merged
 * firm's FEIs to the kept firm; an FEI whose row still names a merged-away firm is held by the firm it was merged into,
 * which its alias names (aliases are one hop).
 */
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
    .where(notInArray(firm.id, mergedAway(db)))
    .orderBy(asc(firm.id));
  const holders = await db
    .select({ fei: firmFei.fei, firmId: sql<number>`coalesce(${firmAlias.newId}, ${firmFei.firmId})`.mapWith(Number) })
    .from(firmFei)
    .leftJoin(firmAlias, eq(firmAlias.oldId, firmFei.firmId))
    .orderBy(asc(firmFei.fei));
  const feis = new Map<number, number[]>();
  for (const { fei, firmId } of holders) {
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

const NO_ADDRESS: NormalizedAddress = {
  countryCode: null,
  region: null,
  city: null,
  postalCode: null,
  addressNorm: null,
};

/**
 * A record's address: its parts normalised, in the country its row's `country_code` names. The sync stored that code
 * normalised, and loadFrequencyNames counts the record's name under it, so the engine takes it as it is: a record is
 * scored against the token frequencies of its own country.
 */
function recordAddress(parts: Omit<RawAddress, 'country'>, countryCode: string | null): NormalizedAddress | null {
  const address = normalizeAddress(parts);
  return countryCode === null ? address : { ...(address ?? NO_ADDRESS), countryCode };
}

const commodityIdsOf = (commodityId: number | null): number[] => (commodityId === null ? [] : [commodityId]);

/** FDA refusals. The address comes in fields, which a person reads joined by commas. */
async function loadRefusals(db: DbOrTx, opts: LoadOptions): Promise<LoadedRecord[]> {
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
    .where(whichRecords(opts, fdaRefusal.firmId))
    .orderBy(asc(fdaRefusal.id));
  return rows.map((row) => ({
    record: {
      source: 'fda_refusal',
      key: row.key,
      fei: row.fei,
      firmName: row.firmName,
      nameNorm: row.nameNorm,
      address: recordAddress(
        {
          line1: row.addressLine1,
          line2: row.addressLine2,
          city: row.city,
          region: row.region,
          postalCode: row.postalCode,
        },
        row.countryCode,
      ),
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
async function loadListings(db: DbOrTx, opts: LoadOptions): Promise<LoadedRecord[]> {
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
    .where(whichRecords(opts, importAlertListing.firmId))
    .orderBy(asc(importAlertListing.id));
  return rows.map((row) => ({
    record: {
      source: 'import_alert',
      key: row.key,
      fei: null,
      firmName: row.firmName,
      nameNorm: row.nameNorm,
      address: recordAddress(
        {
          line1:
            row.addressRaw === null
              ? null
              : stripLocationTail(row.addressRaw, { city: row.city, region: row.region, country: row.countryName }),
          city: row.city,
          region: row.region,
        },
        row.countryCode,
      ),
      commodityIds: commodityIdsOf(row.commodityId),
      seenOn: row.seenOn,
    },
    firmId: row.firmId,
    rawAddress: row.addressRaw,
  }));
}

/** Australian failed tests that name a producer; the file gives only the producer's country. */
async function loadAuRows(db: DbOrTx, opts: LoadOptions): Promise<LoadedRecord[]> {
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
    .where(and(whichRecords(opts, auFailingFood.firmId), ne(auFailingFood.nameNorm, '')))
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
              address: recordAddress({}, countryCode),
              commodityIds: commodityIdsOf(commodityId),
              seenOn,
            },
            firmId,
            rawAddress: null,
          },
        ],
  );
}
