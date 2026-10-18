import { classifyCommodity, classifyHazards, type RuleSet } from '@rejectradar/taxonomy';
import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { countryFromName } from '../../core/country';

/** The FSA open-data package that lists one border-notification CSV per month. */
export const UK_PACKAGE_URL = 'https://ckan.publishing.service.gov.uk/api/action/package_show?id=6d74a70f-e25a-4d54-a2a6-325c7aa57d74';

export const UK_HEADERS = [
  'DateBNRaised',
  'Country',
  'Commodity',
  'NetWeight',
  'ProductCategory',
  'ProductName',
  'ControlledByLegislationYOrN',
  'TypeOfConsignment',
  'HazardCategory',
  'TypeOfFailure',
  'ReasonForFailure',
] as const;

type UkHeader = (typeof UK_HEADERS)[number];

export interface UkRow {
  sourceKey: string;
  /** `YYYY-MM-DD`. */
  notifiedOn: string;
  /** ISO 3166-1 alpha-2, or null when the file gives none or one we do not recognise. */
  originCountry: string | null;
  commodity: string | null;
  productCategory: string | null;
  productName: string | null;
  hazardCategory: string | null;
  failureType: string | null;
  reason: string | null;
  consignmentType: string | null;
  legislationControlled: string | null;
}

const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** `DD/MM/YYYY` to `YYYY-MM-DD`; null when it is not a real calendar date. */
function parseDate(value: string): string | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

const orNull = (value: string): string | null => (value === '' ? null : value);

/** Maps each expected header to its column; unknown, duplicate and missing headers all fail, naming the header. */
function columnIndexes(header: readonly string[]): Record<UkHeader, number> {
  const wanted = new Map<string, UkHeader>(UK_HEADERS.map((name) => [name.toLowerCase(), name]));
  const indexes = new Map<UkHeader, number>();
  const problems: string[] = [];
  header.forEach((cell, index) => {
    const name = wanted.get(cell.trim().toLowerCase());
    if (name === undefined) problems.push(`unexpected header "${cell.trim()}"`);
    else if (indexes.has(name)) problems.push(`duplicate header "${cell.trim()}"`);
    else indexes.set(name, index);
  });
  for (const name of UK_HEADERS) if (!indexes.has(name)) problems.push(`missing header "${name}"`);
  if (problems.length > 0) throw new Error(`UK border-notification file: ${problems.join('; ')}`);
  return Object.fromEntries(indexes) as Record<UkHeader, number>;
}

/**
 * Reads one monthly file. Headers are checked after a byte-order mark and padding are removed, in any case. Blank rows
 * (the files sometimes end with `,,,,,,,,,,`) are skipped. The key hashes the month, all eleven values and the position
 * among identical rows, so a row that is edited in a later release gets a new key; the sync pairs it with the key it
 * replaces and updates that row in place (see `syncMonthlyFiles`).
 */
export function parseUkCsv(csv: string, month: string): UkRow[] {
  const records = parse(csv, { bom: true, skip_empty_lines: true }) as string[][];
  if (records.length === 0) throw new Error('UK border-notification file: no header row');
  const at = columnIndexes(records[0]);

  const seen = new Map<string, number>();
  const rows: UkRow[] = [];
  records.slice(1).forEach((record, offset) => {
    const values = Object.fromEntries(UK_HEADERS.map((name) => [name, (record[at[name]] ?? '').trim()])) as Record<UkHeader, string>;
    const all = UK_HEADERS.map((name) => values[name]);
    if (all.every((value) => value === '')) return;

    const where = `row ${offset + 2}`;
    if (values.DateBNRaised === '') throw new Error(`UK border-notification file: ${where} has no date`);
    const notifiedOn = parseDate(values.DateBNRaised);
    if (notifiedOn === null) throw new Error(`UK border-notification file: ${where} has a date that is not DD/MM/YYYY: "${values.DateBNRaised}"`);

    const identical = JSON.stringify(all);
    const ordinal = seen.get(identical) ?? 0;
    seen.set(identical, ordinal + 1);
    const sourceKey = createHash('sha256').update(JSON.stringify([month, all, ordinal])).digest('hex').slice(0, 40);

    rows.push({
      sourceKey,
      notifiedOn,
      originCountry: countryFromName(values.Country),
      commodity: orNull(values.Commodity),
      productCategory: orNull(values.ProductCategory),
      productName: orNull(values.ProductName),
      hazardCategory: orNull(values.HazardCategory),
      failureType: orNull(values.TypeOfFailure),
      reason: orNull(values.ReasonForFailure),
      consignmentType: orNull(values.TypeOfConsignment),
      legislationControlled: orNull(values.ControlledByLegislationYOrN),
    });
  });
  return rows;
}

/**
 * The commodity comes from the HS/CN code, then the product category, then the product name. Hazards come from the
 * hazard category and, as free text, from the failure type and reason. Spelling variants ("&" or "and", "Docmentary")
 * are handled by the rules, which compare normalised text.
 */
export function classifyUk(rules: RuleSet, r: UkRow): { commodityId: number; hazardIds: number[] } {
  return {
    commodityId: classifyCommodity(rules, 'uk_bn', { commodity: r.commodity, product_category: r.productCategory, product_name: r.productName }),
    hazardIds: classifyHazards(rules, 'uk_bn', { hazard_category: [r.hazardCategory], reason: [r.reason, r.failureType] }),
  };
}
