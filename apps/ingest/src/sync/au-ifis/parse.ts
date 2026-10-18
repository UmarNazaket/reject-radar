import { normalizeName } from '@rejectradar/matching';
import { classifyCommodity, classifyHazards, type RuleSet } from '@rejectradar/taxonomy';
import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { countryFromName } from '../../core/country';

/** The data.gov.au package that lists one failing-food CSV per month. */
export const AU_PACKAGE_URL = 'https://data.gov.au/data/api/3/action/package_show?id=imported-food-inspection-scheme-monthly-failing-food-reports';

export type AuField = 'failedOn' | 'product' | 'country' | 'producer' | 'test' | 'result' | 'reference' | 'category';

/**
 * Every header spelling seen so far, lower-cased and trimmed. The department renames columns from month to month
 * ("County of origin" became "Country of origin", "Food category" became "Referral category").
 */
export const AU_HEADER_ALIASES: Readonly<Record<AuField, readonly string[]>> = {
  failedOn: ['date of fail'],
  product: ['product description'],
  country: ['county of origin', 'country of origin'],
  producer: ['producer name'],
  test: ['test applied / reason for fail', 'reason for fail', 'test applied'],
  result: ['results / units', 'results'],
  reference: ['reference criteria'],
  category: ['food category', 'referral category'],
};

export const AU_REQUIRED: readonly AuField[] = ['failedOn', 'product', 'country', 'producer', 'test'];

export interface AuRecord {
  sourceKey: string;
  /** `YYYY-MM-01`, the month of the report file. */
  reportMonth: string;
  /** `YYYY-MM-DD`; null when the file gives no date. */
  failedOn: string | null;
  productDesc: string;
  /** ISO 3166-1 alpha-2, or null when the file gives none or one we do not recognise. */
  countryCode: string | null;
  producerName: string | null;
  /** Normalised producer name for matching; `''` when no producer is named. */
  nameNorm: string;
  /** Every failed test of the record, in file order, joined with `; `. */
  testApplied: string;
  /** The source has one column for the test and the reason, so this holds the same text as `testApplied`. */
  reason: string;
  /** The results of the tests, in file order, joined with `; `. */
  resultText: string | null;
  /** True when the referral category names a holding order (`HO match 20158`). */
  holdingOrderMatch: boolean | null;
  scheme: 'risk' | 'surveillance' | null;
}

const TEST_SEPARATOR = '; ';

/** The department's files are mostly UTF-8 but some are Windows-1252 (an en dash is a single 0x96 byte). */
export function decodeAuCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** `D/MM/YYYY` to `YYYY-MM-DD`; null when it is not a real calendar date. */
function parseDate(value: string): string | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

const orNull = (value: string): string | null => (value === '' ? null : value);

const ALIAS_TO_FIELD = new Map<string, AuField>(
  (Object.entries(AU_HEADER_ALIASES) as [AuField, readonly string[]][]).flatMap(([field, aliases]) => aliases.map((alias): [string, AuField] => [alias, field])),
);

const headerKey = (cell: string): string => cell.trim().replace(/\s+/g, ' ').toLowerCase();

/** Maps each field to its column. Unknown and repeated headers fail, and so does a missing required column. */
function columnIndexes(header: readonly string[]): Map<AuField, number> {
  const indexes = new Map<AuField, number>();
  const problems: string[] = [];
  header.forEach((cell, index) => {
    if (cell.trim() === '') return;
    const field = ALIAS_TO_FIELD.get(headerKey(cell));
    if (field === undefined) problems.push(`unexpected header "${cell.trim()}"`);
    else if (indexes.has(field)) problems.push(`duplicate header "${cell.trim()}"`);
    else indexes.set(field, index);
  });
  for (const field of AU_REQUIRED) {
    if (!indexes.has(field)) problems.push(`missing required column "${field}" (one of: ${AU_HEADER_ALIASES[field].join(', ')})`);
  }
  if (problems.length > 0) throw new Error(`Australian failing-food file: ${problems.join('; ')}`);
  return indexes;
}

/** `HO match 20158`, `HO number 20561`, the 2026 June files' bare `HOM` (holding-order match) or the words. */
const HOLDING_ORDER = /\bHOM?\b|holding order/i;

function schemeOf(category: string): AuRecord['scheme'] {
  const text = category.toLowerCase();
  if (text.startsWith('surveillance')) return 'surveillance';
  if (text.startsWith('risk')) return 'risk';
  return null;
}

/** A record being built: its first row plus the tests and results of its continuation rows. */
interface Draft {
  failedOn: string | null;
  product: string;
  country: string;
  producer: string;
  tests: string[];
  results: string[];
  category: string;
}

/**
 * Reads one monthly file. Headers are matched by alias after trimming and lower-casing. Fully blank rows are skipped.
 * A continuation row (no date, product, country or producer, but a test or a result) adds a failed test to the record
 * above it. The key hashes the month, the record's identifying fields, its first test and its position among records
 * that are otherwise identical; the results are left out so a corrected result keeps the key. Any other correction gives
 * a new key, which the sync pairs with the key it replaces and updates in place (see `syncMonthlyFiles`).
 */
export function parseAuCsv(csv: string, reportMonth: string): AuRecord[] {
  const rows = parse(csv, { bom: true, skip_empty_lines: true, relax_column_count: true }) as string[][];
  if (rows.length === 0) throw new Error('Australian failing-food file: no header row');
  const at = columnIndexes(rows[0]);

  const drafts: Draft[] = [];
  rows.slice(1).forEach((row, offset) => {
    const cell = (field: AuField): string => {
      const index = at.get(field);
      return index === undefined ? '' : (row[index] ?? '').trim();
    };
    const [date, product, country, producer, test, result] = [cell('failedOn'), cell('product'), cell('country'), cell('producer'), cell('test'), cell('result')];
    const where = `row ${offset + 2}`;

    if (date === '' && product === '' && country === '' && producer === '') {
      if (test === '' && result === '') return;
      const previous = drafts[drafts.length - 1];
      if (previous === undefined) throw new Error(`Australian failing-food file: ${where} continues a record, but there is none above it`);
      if (test !== '') previous.tests.push(test);
      if (result !== '') previous.results.push(result);
      return;
    }

    if (product === '') throw new Error(`Australian failing-food file: ${where} has no product description`);
    let failedOn: string | null = null;
    if (date !== '') {
      failedOn = parseDate(date);
      if (failedOn === null) throw new Error(`Australian failing-food file: ${where} has a date that is not D/MM/YYYY: "${date}"`);
    }
    drafts.push({
      failedOn,
      product,
      country,
      producer,
      tests: test === '' ? [] : [test],
      results: result === '' ? [] : [result],
      category: cell('category'),
    });
  });

  const seen = new Map<string, number>();
  return drafts.map((draft): AuRecord => {
    const identity = JSON.stringify([reportMonth, draft.failedOn ?? '', draft.product, draft.producer, draft.country, draft.tests[0] ?? '']);
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    const sourceKey = createHash('sha256').update(`${identity}|${ordinal}`).digest('hex').slice(0, 40);

    const testApplied = draft.tests.join(TEST_SEPARATOR);
    const producerName = orNull(draft.producer);
    return {
      sourceKey,
      reportMonth,
      failedOn: draft.failedOn,
      productDesc: draft.product,
      countryCode: countryFromName(draft.country),
      producerName,
      nameNorm: producerName === null ? '' : normalizeName(producerName).primary,
      testApplied,
      reason: testApplied,
      resultText: draft.results.length === 0 ? null : draft.results.join(TEST_SEPARATOR),
      holdingOrderMatch: HOLDING_ORDER.test(draft.category) ? true : null,
      scheme: schemeOf(draft.category),
    };
  });
}

/** The failed tests of a record, in file order. */
export const testsOf = (r: Pick<AuRecord, 'testApplied'>): string[] => (r.testApplied === '' ? [] : r.testApplied.split(TEST_SEPARATOR));

/** The commodity comes from the product description; every failed test is a hazard text of its own. */
export function classifyAu(rules: RuleSet, r: AuRecord): { commodityId: number; hazardIds: number[] } {
  return {
    commodityId: classifyCommodity(rules, 'au_ifis', { product_desc: r.productDesc }),
    hazardIds: classifyHazards(rules, 'au_ifis', { test: testsOf(r) }),
  };
}
