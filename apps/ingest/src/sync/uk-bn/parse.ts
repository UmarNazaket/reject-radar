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
  /** The country as the file writes it, or null when it gives none. */
  countryName: string | null;
  commodity: string | null;
  productCategory: string | null;
  productName: string | null;
  hazardCategory: string | null;
  failureType: string | null;
  reason: string | null;
  consignmentType: string | null;
  legislationControlled: string | null;
}

/** Headers a file may leave out: the January 2023 to June 2024 files have no `NetWeight` (it is not stored anyway). */
const OPTIONAL_HEADERS: ReadonlySet<UkHeader> = new Set(['NetWeight']);

/** `DD/MM/YYYY` (the 2024-26 files; a stray leading zero as in `24/011/2024` is accepted) or `YYYY-MM-DD` (2023-24). */
const DMY = /^(\d{1,3})\/(\d{1,3})\/(\d+)$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The date as `YYYY-MM-DD`, or null when the parts are not a real calendar date. */
function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Reads a date of a file for `month` (`YYYY-MM`). A `DD/MM/YYYY` value that is not a real date because its month or its
 * year is garbled, while the other one matches the file's month (`28/12/82024` and `19/24/2024` in the December 2024
 * file), is read as that day of the file's month, with a warning. Any other unreadable date is null.
 */
function parseDate(value: string, month: string, where: string): string | null {
  const iso = ISO.exec(value);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = DMY.exec(value);
  if (!dmy) return null;
  const [day, monthOfYear, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  const read = isoDate(year, monthOfYear, day);
  if (read !== null) return read;
  const [fileYear, fileMonth] = month.split('-').map(Number);
  if (monthOfYear !== fileMonth && year !== fileYear) return null;
  const repaired = isoDate(fileYear, fileMonth, day);
  if (repaired !== null) console.warn(`UK border-notification file ${month}: ${where} has a garbled date "${value}"; read as ${repaired}`);
  return repaired;
}

const orNull = (value: string): string | null => (value === '' ? null : value);

interface Columns {
  /** The column of each header the file has. */
  at: Partial<Record<UkHeader, number>>;
  /** Columns with a blank header (the 2025 files pad the header with empty cells); they must hold no data. */
  blank: number[];
}

/** Maps each expected header to its column; unknown, duplicate and missing headers all fail, naming the header. */
function columnIndexes(header: readonly string[]): Columns {
  const wanted = new Map<string, UkHeader>(UK_HEADERS.map((name) => [name.toLowerCase(), name]));
  const at: Partial<Record<UkHeader, number>> = {};
  const blank: number[] = [];
  const problems: string[] = [];
  header.forEach((cell, index) => {
    if (cell.trim() === '') {
      blank.push(index);
      return;
    }
    const name = wanted.get(cell.trim().toLowerCase());
    if (name === undefined) problems.push(`unexpected header "${cell.trim()}"`);
    else if (at[name] !== undefined) problems.push(`duplicate header "${cell.trim()}"`);
    else at[name] = index;
  });
  for (const name of UK_HEADERS) if (at[name] === undefined && !OPTIONAL_HEADERS.has(name)) problems.push(`missing header "${name}"`);
  if (problems.length > 0) throw new Error(`UK border-notification file: ${problems.join('; ')}`);
  return { at, blank };
}

/**
 * Reads one monthly file. Headers are checked after a byte-order mark and padding are removed, in any case; blank
 * header cells after the columns are ignored, and `NetWeight` may be absent (January 2023 to June 2024). Dates are
 * `DD/MM/YYYY` or `YYYY-MM-DD`. Blank rows (the files sometimes end with `,,,,,,,,,,`) are skipped. The key hashes the month, all eleven values and the position
 * among identical rows, so a row that is edited in a later release gets a new key; the sync pairs it with the key it
 * replaces and updates that row in place (see `syncMonthlyFiles`).
 */
export function parseUkCsv(csv: string, month: string): UkRow[] {
  const records = parse(csv, { bom: true, skip_empty_lines: true }) as string[][];
  if (records.length === 0) throw new Error('UK border-notification file: no header row');
  const { at, blank } = columnIndexes(records[0]);

  const seen = new Map<string, number>();
  const rows: UkRow[] = [];
  records.slice(1).forEach((record, offset) => {
    const where = `row ${offset + 2}`;
    const cell = (index: number | undefined): string => (index === undefined ? '' : (record[index] ?? '').trim());
    // A missing optional column reads as blank, so the key of a row is the same whichever layout carried it.
    const values = Object.fromEntries(UK_HEADERS.map((name) => [name, cell(at[name])])) as Record<UkHeader, string>;
    const stray = blank.map(cell).find((value) => value !== '');
    if (stray !== undefined) throw new Error(`UK border-notification file: ${where} has a value under a blank header: "${stray}"`);
    const all = UK_HEADERS.map((name) => values[name]);
    if (all.every((value) => value === '')) return;

    if (values.DateBNRaised === '') throw new Error(`UK border-notification file: ${where} has no date`);
    const notifiedOn = parseDate(values.DateBNRaised, month, where);
    if (notifiedOn === null) {
      throw new Error(`UK border-notification file: ${where} has a date that is not DD/MM/YYYY or YYYY-MM-DD: "${values.DateBNRaised}"`);
    }

    const identical = JSON.stringify(all);
    const ordinal = seen.get(identical) ?? 0;
    seen.set(identical, ordinal + 1);
    const sourceKey = createHash('sha256').update(JSON.stringify([month, all, ordinal])).digest('hex').slice(0, 40);

    rows.push({
      sourceKey,
      notifiedOn,
      originCountry: countryFromName(values.Country),
      countryName: orNull(values.Country),
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
