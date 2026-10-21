import { auFailingFood, fdaRefusal, firm, firmAlias, firmFei, importAlertListing, notice } from '@rejectradar/db';
import { normalizeAddress, type NormalizedAddress, stripLocationTail } from '@rejectradar/matching';
import { and, asc, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { DbOrTx, FirmRecord, KnownFirm } from './types';

/**
 * What a linking run starts from: every firm that can still receive records, and every unlinked record that names a
 * firm. Firms come by id; records by source (FDA, Import Alert, Australia), each in the order its rows were stored.
 */
export async function loadLinkInput(db: DbOrTx): Promise<{ firms: KnownFirm[]; records: FirmRecord[] }> {
  const firms = await loadFirms(db);
  const records = [...(await loadRefusals(db)), ...(await loadListings(db)), ...(await loadAuRows(db))];
  return { firms, records };
}

/** The firms not merged away (P3-D9), with the FEIs they hold, ascending. */
async function loadFirms(db: DbOrTx): Promise<KnownFirm[]> {
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

async function loadRefusals(db: DbOrTx): Promise<FirmRecord[]> {
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
    })
    .from(fdaRefusal)
    .where(isNull(fdaRefusal.firmId))
    .orderBy(asc(fdaRefusal.id));
  return rows.map((row) => ({
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
  }));
}

/**
 * Import Alert listings. `address_raw` ends in the city, region and country (P3-D3), which are cut off against the
 * country as the page writes it, before the address is normalised. Only a Red List listing has a notice, which holds
 * its commodity.
 */
async function loadListings(db: DbOrTx): Promise<FirmRecord[]> {
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
    })
    .from(importAlertListing)
    .leftJoin(notice, and(eq(notice.source, 'import_alert'), eq(notice.sourceKey, importAlertListing.listingKey)))
    .where(isNull(importAlertListing.firmId))
    .orderBy(asc(importAlertListing.id));
  return rows.map((row) => ({
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
  }));
}

/** Australian failed tests that name a producer; the file gives only the producer's country. */
async function loadAuRows(db: DbOrTx): Promise<FirmRecord[]> {
  const rows = await db
    .select({
      key: auFailingFood.sourceKey,
      producerName: auFailingFood.producerName,
      nameNorm: auFailingFood.nameNorm,
      countryCode: auFailingFood.countryCode,
      commodityId: auFailingFood.commodityId,
      seenOn: sql<string>`coalesce(${auFailingFood.failedOn}, ${auFailingFood.reportMonth})`,
    })
    .from(auFailingFood)
    .where(and(isNull(auFailingFood.firmId), ne(auFailingFood.nameNorm, '')))
    .orderBy(asc(auFailingFood.id));
  // name_norm is '' whenever there is no producer, so this only tells the compiler the name is there.
  return rows.flatMap(({ key, producerName, nameNorm, countryCode, commodityId, seenOn }) =>
    producerName === null
      ? []
      : [
          {
            source: 'au_ifis',
            key,
            fei: null,
            firmName: producerName,
            nameNorm,
            address: normalizeAddress({ country: countryCode }),
            commodityIds: commodityIdsOf(commodityId),
            seenOn,
          },
        ],
  );
}
