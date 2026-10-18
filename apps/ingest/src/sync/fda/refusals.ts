import { fdaChargeCode, fdaRefusal } from '@rejectradar/db';
import { normalizeAddress, normalizeName } from '@rejectradar/matching';
import { classifyCommodity, UNCLASSIFIED_ID, type RuleSet } from '@rejectradar/taxonomy';
import { sql } from 'drizzle-orm';
import { countryFromFda } from '../../core/country';
import type { SyncDeps } from '../../core/deps';
import { FDA_MAX_ROWS, FDA_REFUSALS_URL, fetchRefusalsPage, type FdaCredentials } from '../../verify/fda-api';
import { insertEvents, upsertNotices, type EventInput, type NoticeInput } from '../../core/notices';
import { runSync, type SyncRunResult } from '../../core/sync-run';

/** The ProductCategory values this product covers; the API filters on them. */
export const FDA_FOOD_CATEGORIES = ['Human Foods', 'Animal Feed'] as const;

/** Days of history a default run re-reads, so late corrections to recent refusals are picked up. */
export const DEFAULT_WINDOW_DAYS = 120;

export interface RefusalRecord {
  sourceKey: string;
  fei: number | null;
  firmName: string;
  nameNorm: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  divisionCode: string | null;
  industryCode: string | null;
  productCode: string | null;
  productDesc: string | null;
  productCategory: string;
  refusalDate: string;
  chargeCodes: string[];
  fdaSampleAnalysis: boolean | null;
  privateLabAnalysis: boolean | null;
  /** FDA's firm-profile page; kept on the notice, not in `fda_refusal`. */
  firmProfile: string | null;
}

const DATE = /^(\d{4}-\d{2}-\d{2})/;

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function yesNo(value: unknown): boolean | null {
  const answer = text(value)?.toLowerCase();
  if (answer === 'yes' || answer === 'y') return true;
  if (answer === 'no' || answer === 'n') return false;
  return null;
}

/** Turns one Data Dashboard record into a {@link RefusalRecord}; throws when a field the sync cannot do without is missing. */
export function parseRefusal(raw: Record<string, unknown>): RefusalRecord {
  const sourceKey = text(raw['ShipmentID']);
  if (sourceKey === null) throw new Error(`FDA refusal without ShipmentID: ${JSON.stringify(raw).slice(0, 200)}`);
  const firmName = text(raw['FirmName']);
  if (firmName === null) throw new Error(`FDA refusal ${sourceKey} has no FirmName`);
  const refusalDate = DATE.exec(text(raw['RefusalDate']) ?? '')?.[1];
  if (refusalDate === undefined) throw new Error(`FDA refusal ${sourceKey} has no valid RefusalDate (${String(raw['RefusalDate'])})`);

  const fei = Number(text(raw['FEINumber']));
  const countryCode = countryFromFda(text(raw['CountryCode']), text(raw['CountryName']));
  const address = normalizeAddress({
    line1: text(raw['AddressLine1']),
    line2: text(raw['AddressLine2']),
    city: text(raw['City']),
    region: text(raw['State']),
    postalCode: text(raw['ZipCode']),
    country: countryCode,
  });

  return {
    sourceKey,
    fei: Number.isSafeInteger(fei) && fei > 0 ? fei : null,
    firmName,
    nameNorm: normalizeName(firmName).primary,
    addressLine1: text(raw['AddressLine1']),
    addressLine2: text(raw['AddressLine2']),
    city: text(raw['City']),
    region: text(raw['State']),
    postalCode: address?.postalCode ?? null,
    countryCode,
    divisionCode: text(raw['DistrictCode']),
    industryCode: text(raw['IndustryCode']),
    productCode: text(raw['ProductCode']),
    productDesc: text(raw['ProductCodeDescription']),
    productCategory: text(raw['ProductCategory']) ?? '',
    refusalDate,
    chargeCodes: (text(raw['RefusalCharges']) ?? '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean),
    fdaSampleAnalysis: yesNo(raw['FDASampleAnalysis']),
    privateLabAnalysis: yesNo(raw['PrivateLabAnalysis']),
    firmProfile: text(raw['FirmProfile']),
  };
}

/**
 * The commodity comes from the industry code and product description; the hazards are the union of the hazards
 * of the refusal's charge codes (`chargeHazards`: charge code to hazard id, null when none), or "unclassified".
 */
export function classifyRefusal(
  rules: RuleSet,
  chargeHazards: ReadonlyMap<string, number | null>,
  r: RefusalRecord,
): { commodityId: number; hazardIds: number[] } {
  const commodityId = classifyCommodity(rules, 'fda_refusal', { industry_code: r.industryCode, product_desc: r.productDesc });
  const found = new Set<number>();
  for (const code of r.chargeCodes) {
    const hazardId = chargeHazards.get(code);
    if (hazardId !== null && hazardId !== undefined) found.add(hazardId);
  }
  return { commodityId, hazardIds: found.size === 0 ? [UNCLASSIFIED_ID] : [...found].sort((a, b) => a - b) };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const BATCH_SIZE = 500;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Most pages one calendar-month slice may take; a month of food refusals is about one page, so more means something is wrong. */
export const MAX_PAGES_PER_SLICE = 20;

const lastDayOfMonth = (date: string): string => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};

/**
 * Splits [from, to] into calendar-month slices: from `from` to the end of its month, whole months, then up to `to`.
 * The API pages on `RefusalDate`, which is not unique, so a slice must fit one page or paging can skip or repeat rows.
 */
export function monthSlices(from: string, to: string): { from: string; to: string }[] {
  const slices: { from: string; to: string }[] = [];
  for (let start = from; start <= to; ) {
    const monthEnd = lastDayOfMonth(start);
    slices.push({ from: start, to: monthEnd < to ? monthEnd : to });
    start = addDays(monthEnd, 1);
  }
  return slices;
}

/** Reads every page of one slice; a page shorter than the maximum is the last one. */
async function fetchSlice(deps: SyncDeps, creds: FdaCredentials, from: string, to: string): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (let page = 0; page < MAX_PAGES_PER_SLICE; page++) {
    const result = await fetchRefusalsPage(deps.fetcher, creds, {
      from,
      to,
      start: page * FDA_MAX_ROWS + 1,
      rows: FDA_MAX_ROWS,
      productCategories: FDA_FOOD_CATEGORIES,
      sort: 'RefusalDate',
    });
    records.push(...result.records);
    if (result.records.length < FDA_MAX_ROWS) return records;
  }
  throw new Error(`FDA refusals for ${from} to ${to} exceeded ${MAX_PAGES_PER_SLICE} pages of ${FDA_MAX_ROWS} rows; stopping.`);
}

async function fetchAll(deps: SyncDeps, creds: FdaCredentials, from: string, to: string): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const slice of monthSlices(from, to)) records.push(...(await fetchSlice(deps, creds, slice.from, slice.to)));
  return records;
}

/**
 * Syncs FDA import refusals of food and feed for a date window (default: the last 120 days) into `fda_refusal` and
 * `notice`, in one transaction. New notices produce a `fda_refusal` change event unless `events` is false.
 */
export async function syncFdaRefusals(
  deps: SyncDeps & { creds: FdaCredentials },
  options: { from?: string; to?: string; events: boolean },
): Promise<SyncRunResult> {
  const to = options.to ?? deps.today();
  const from = options.from ?? addDays(to, -DEFAULT_WINDOW_DAYS);
  for (const value of [from, to]) {
    if (!DATE_ONLY.test(value)) throw new Error(`Invalid date "${value}"; use YYYY-MM-DD`);
  }

  return runSync(deps.db, 'fda_refusals', async (ctx) => {
    ctx.setOrigin(FDA_REFUSALS_URL);
    const raw = await fetchAll(deps, deps.creds, from, to);
    ctx.counts.rowsRead = raw.length;

    const chargeRows = await deps.db.select({ code: fdaChargeCode.code, hazardId: fdaChargeCode.hazardId }).from(fdaChargeCode);
    if (chargeRows.length === 0) console.warn('fda_charge_code is empty: run sync:fda-charge-codes first, or hazards will be "unclassified".');
    const chargeHazards = new Map(chargeRows.map((row) => [row.code, row.hazardId]));

    // Parse and classify everything before writing; one bad record fails the run with nothing written.
    const classified = [...new Map(raw.map(parseRefusal).map((record) => [record.sourceKey, record])).values()].map((record) => ({
      record,
      ...classifyRefusal(deps.rules, chargeHazards, record),
    }));

    let rowsInserted = 0;
    let rowsUpdated = 0;
    let eventsEmitted = 0;

    await deps.db.transaction(async (tx) => {
      for (let i = 0; i < classified.length; i += BATCH_SIZE) {
        // `firmProfile` is not a column; the insert ignores it.
        const batch = classified.slice(i, i + BATCH_SIZE).map(({ record, commodityId, hazardIds }) => ({ ...record, commodityId, hazardIds }));
        const returned = await tx
          .insert(fdaRefusal)
          .values(batch)
          .onConflictDoUpdate({
            target: fdaRefusal.sourceKey,
            set: {
              fei: sql`excluded.fei`,
              firmName: sql`excluded.firm_name`,
              nameNorm: sql`excluded.name_norm`,
              addressLine1: sql`excluded.address_line1`,
              addressLine2: sql`excluded.address_line2`,
              city: sql`excluded.city`,
              region: sql`excluded.region`,
              postalCode: sql`excluded.postal_code`,
              countryCode: sql`excluded.country_code`,
              divisionCode: sql`excluded.division_code`,
              industryCode: sql`excluded.industry_code`,
              productCode: sql`excluded.product_code`,
              productDesc: sql`excluded.product_desc`,
              productCategory: sql`excluded.product_category`,
              refusalDate: sql`excluded.refusal_date`,
              chargeCodes: sql`excluded.charge_codes`,
              fdaSampleAnalysis: sql`excluded.fda_sample_analysis`,
              privateLabAnalysis: sql`excluded.private_lab_analysis`,
              commodityId: sql`excluded.commodity_id`,
              hazardIds: sql`excluded.hazard_ids`,
            },
            setWhere: sql`(${fdaRefusal.fei}, ${fdaRefusal.firmName}, ${fdaRefusal.nameNorm}, ${fdaRefusal.addressLine1}, ${fdaRefusal.addressLine2}, ${fdaRefusal.city}, ${fdaRefusal.region}, ${fdaRefusal.postalCode}, ${fdaRefusal.countryCode}, ${fdaRefusal.divisionCode}, ${fdaRefusal.industryCode}, ${fdaRefusal.productCode}, ${fdaRefusal.productDesc}, ${fdaRefusal.productCategory}, ${fdaRefusal.refusalDate}, ${fdaRefusal.chargeCodes}, ${fdaRefusal.fdaSampleAnalysis}, ${fdaRefusal.privateLabAnalysis}, ${fdaRefusal.commodityId}, ${fdaRefusal.hazardIds})
              is distinct from
              (excluded.fei, excluded.firm_name, excluded.name_norm, excluded.address_line1, excluded.address_line2, excluded.city, excluded.region, excluded.postal_code, excluded.country_code, excluded.division_code, excluded.industry_code, excluded.product_code, excluded.product_desc, excluded.product_category, excluded.refusal_date, excluded.charge_codes, excluded.fda_sample_analysis, excluded.private_lab_analysis, excluded.commodity_id, excluded.hazard_ids)`,
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        for (const row of returned) {
          if (row.inserted) rowsInserted++;
          else rowsUpdated++;
        }
      }

      const notices: NoticeInput[] = classified.map(({ record, commodityId, hazardIds }) => ({
        source: 'fda_refusal',
        sourceKey: record.sourceKey,
        noticeType: 'refusal',
        noticeOn: record.refusalDate,
        originCountry: record.countryCode,
        commodityId,
        hazardIds,
        productText: record.productDesc,
        firmName: record.firmName,
        title: `${record.firmName} refused: ${record.productDesc ?? 'unspecified product'}`,
        url: record.firmProfile,
      }));
      const upserted = await upsertNotices(tx, notices);

      if (options.events) {
        const events: EventInput[] = [];
        for (const { record, commodityId, hazardIds } of classified) {
          const written = upserted.get(record.sourceKey);
          if (!written?.inserted) continue;
          events.push({
            source: 'fda_refusal',
            sourceKey: record.sourceKey,
            kind: 'fda_refusal',
            occurredOn: record.refusalDate,
            requiresFirm: true,
            originCountry: record.countryCode,
            commodityId,
            hazardIds,
            noticeId: written.id,
          });
        }
        eventsEmitted = await insertEvents(tx, events);
      }
    });

    ctx.counts.rowsInserted = rowsInserted;
    ctx.counts.rowsUpdated = rowsUpdated;
    ctx.counts.eventsEmitted = eventsEmitted;
  });
}
