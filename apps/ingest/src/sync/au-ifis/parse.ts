import { normalizeName } from '@rejectradar/matching';
import { classifyCommodity, classifyHazards, type RuleSet } from '@rejectradar/taxonomy';
import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { countryFromName } from '../../core/country';
import { decodeCsv } from '../../core/source-files';

/** The data.gov.au package that lists one failing-food CSV per month. */
export const AU_PACKAGE_URL = 'https://data.gov.au/data/api/3/action/package_show?id=imported-food-inspection-scheme-monthly-failing-food-reports';

export type AuField = 'category' | 'failedOn' | 'product' | 'country' | 'producer' | 'test' | 'reason' | 'result' | 'units' | 'reference' | 'holdingOrder';

/**
 * Every header spelling seen so far, lower-cased and trimmed, with one space each side of a slash. The department
 * renames columns from month to month ("County of origin" became "Country of origin", "Food category" became "Referral
 * category", "Reference" became "Reference criteria" and, once, "Standard" or "Reference Critera"). Until February 2022
 * the test applied and the reason for fail had columns of their own, and so did the results ("Result/s") and the units.
 */
export const AU_HEADER_ALIASES: Readonly<Record<AuField, readonly string[]>> = {
  category: ['food category', 'referral category', 'category'],
  failedOn: ['date of fail'],
  product: ['product description'],
  country: ['county of origin', 'country of origin'],
  producer: ['producer name'],
  test: ['test applied / reason for fail', 'test applied'],
  reason: ['reason for fail'],
  result: ['results / units', 'results', 'result / s'],
  units: ['units'],
  reference: ['reference criteria', 'reference', 'standard', 'reference critera'],
  holdingOrder: ['holding order number'],
};

/** The columns every table needs; a reason column alone serves as the test column too. */
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
  /**
   * The reasons for fail, in file order, joined with `; `. A table with one column for the test and the reason (every
   * file since March 2022, and the risk tables before it) gives the same text here as in `testApplied`.
   */
  reason: string;
  /** The results of the tests with their units, in file order, joined with `; `. */
  resultText: string | null;
  /** True when the referral category or the holding order number names a holding order (`HO match 20158`). */
  holdingOrderMatch: boolean | null;
  scheme: 'risk' | 'surveillance' | null;
}

type Scheme = AuRecord['scheme'];

const TEST_SEPARATOR = '; ';
const ERROR = 'Australian failing-food file:';

/** The department's files are mostly UTF-8 but some are Windows-1252 (an en dash is a single 0x96 byte). */
export const decodeAuCsv = decodeCsv;

const DATE = /^(\d{1,2})([/.])(\d{1,2})\2(\d{4})$/;
const EXCEL_SERIAL = /^\d{5}$/;
const DAY_MS = 86_400_000;

/**
 * `D/MM/YYYY` (once `D.M.YYYY`, September 2020), or an Excel day number (February 2025 gives `45687` for 30 January
 * 2025; Excel counts from 1899-12-30), to `YYYY-MM-DD`; null when it is none of these, or not a real calendar date.
 */
function parseDate(value: string): string | null {
  if (EXCEL_SERIAL.test(value)) return new Date(Date.UTC(1899, 11, 30) + Number(value) * DAY_MS).toISOString().slice(0, 10);
  const match = DATE.exec(value);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[3]), Number(match[4])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[4]}-${match[3].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

const orNull = (value: string): string | null => (value === '' ? null : value);

const ALIAS_TO_FIELD = new Map<string, AuField>(
  (Object.entries(AU_HEADER_ALIASES) as [AuField, readonly string[]][]).flatMap(([field, aliases]) => aliases.map((alias): [string, AuField] => [alias, field])),
);

const headerKey = (cell: string): string =>
  cell
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/ ?\/ ?/g, ' / ')
    .toLowerCase();

/** A row naming at least two known columns is a header row; a record never does. */
const isHeader = (cells: readonly string[]): boolean => cells.filter((cell) => ALIAS_TO_FIELD.has(headerKey(cell))).length >= 2;

/** The header of the current layout, for February 2025, which has none. */
const CURRENT_HEADER = ['Date of fail', 'Product description', 'Country of origin', 'Producer name', 'Test applied / reason for fail', 'Results / Units', 'Reference criteria', 'Food category'];

/**
 * Maps each field to its column; `test` and `reason` share one when the table has a single column for both. Unknown and
 * repeated headers fail, and so does a missing required column. October 2022 heads its test column "Results / Units",
 * like its results column: with no test column, the first of two results columns is the test column.
 */
function columnIndexes(header: readonly string[], where: string): Map<AuField, number> {
  const indexes = new Map<AuField, number>();
  const results: number[] = [];
  const problems: string[] = [];
  header.forEach((cell, index) => {
    if (cell.trim() === '') return;
    const field = ALIAS_TO_FIELD.get(headerKey(cell));
    if (field === undefined) problems.push(`unexpected header "${cell.trim()}"`);
    else if (field === 'result') results.push(index);
    else if (indexes.has(field)) problems.push(`duplicate header "${cell.trim()}"`);
    else indexes.set(field, index);
  });
  if (results.length === 2 && !indexes.has('test') && !indexes.has('reason')) indexes.set('test', results[0]);
  else if (results.length > 1) problems.push(`duplicate header "${header[results[1]].trim()}"`);
  if (results.length > 0) indexes.set('result', results[results.length - 1]);

  const test = indexes.get('test') ?? indexes.get('reason');
  if (test !== undefined) {
    indexes.set('test', test);
    indexes.set('reason', indexes.get('reason') ?? test);
  }
  for (const field of AU_REQUIRED) {
    const accepted = field === 'test' ? [...AU_HEADER_ALIASES.test, ...AU_HEADER_ALIASES.reason] : AU_HEADER_ALIASES[field];
    if (!indexes.has(field)) problems.push(`missing required column "${field}" (one of: ${accepted.join(', ')})`);
  }
  if (problems.length > 0) throw new Error(`${ERROR} header in ${where}: ${problems.join('; ')}`);
  return indexes;
}

/** One table of a file: its columns, the scheme its title names (if any) and its rows. */
interface Table {
  columns: Map<AuField, number>;
  scheme: Scheme;
  rows: { cells: string[]; where: string }[];
}

/**
 * June 2019's surveillance table repeats the header of the risk tables, which have no test column, but its rows give the
 * test before the reason: one value more than the header. Such a table is read with a test column before the reason.
 */
function withTestColumn(table: Table): Map<AuField, number> {
  const { columns } = table;
  const reason = columns.get('reason');
  if (reason === undefined || columns.get('test') !== reason || !columns.has('units')) return columns;
  const past = Math.max(...columns.values()) + 1;
  if (!table.rows.some(({ cells }) => (cells[past] ?? '') !== '')) return columns;
  const shifted = new Map([...columns].map(([field, index]): [AuField, number] => [field, index >= reason ? index + 1 : index]));
  shifted.set('test', reason);
  return shifted;
}

/** The scheme a table title names ("Risk food tests", "Table 2 Surveillance food test results"), if it names one. */
function titleScheme(text: string): Scheme | undefined {
  const risk = /\brisk\b/i.test(text);
  const surveillance = /\bsurveillance\b/i.test(text);
  if (risk === surveillance) return undefined;
  return risk ? 'risk' : 'surveillance';
}

/**
 * Splits a file into its tables. A file holds one table, or (until December 2021) a title row, a header and records for
 * each of its schemes. A row with text only in its first column is a table title when it names a scheme, or a footnote
 * when it starts with `*`; a footnote is skipped. A file whose first row is a record (February 2025) has the current
 * header.
 */
function tablesOf(rows: readonly string[][]): Table[] {
  const tables: Table[] = [];
  let title: { text: string; scheme: Scheme; where: string } | null = null;
  for (const [index, row] of rows.entries()) {
    const where = `row ${index + 1}`;
    const cells = row.map((cell) => cell.trim());
    if (cells.every((cell) => cell === '')) continue;

    if (isHeader(cells)) {
      tables.push({ columns: columnIndexes(cells, where), scheme: title?.scheme ?? null, rows: [] });
      title = null;
      continue;
    }
    if (cells.slice(1).every((cell) => cell === '')) {
      const text = cells[0];
      if (text.startsWith('*')) continue;
      const scheme = titleScheme(text);
      if (scheme === undefined) {
        throw new Error(`${ERROR} ${where} has text only in its first column, "${text}", but is neither a table title naming risk or surveillance, a footnote starting with * nor a record`);
      }
      if (title !== null) throw new Error(`${ERROR} ${title.where} has the table title "${title.text}", but no header row follows it`);
      title = { text, scheme, where };
      continue;
    }
    if (title !== null) throw new Error(`${ERROR} ${where} follows the table title "${title.text}" (${title.where}) but is not a header row`);

    let table = tables[tables.length - 1];
    if (table === undefined) {
      const width = cells.reduce((last, cell, i) => (cell === '' ? last : i + 1), 0);
      if (parseDate(cells[0]) === null || width > CURRENT_HEADER.length) throw new Error(`${ERROR} no header row`);
      table = { columns: columnIndexes(CURRENT_HEADER, 'the current layout'), scheme: null, rows: [] };
      tables.push(table);
    }
    table.rows.push({ cells, where });
  }
  if (title !== null) throw new Error(`${ERROR} ${title.where} has the table title "${title.text}", but no header row follows it`);
  if (tables.length === 0) throw new Error(`${ERROR} no header row`);
  return tables;
}

/** `HO match 20158`, `HO number 20561`, the 2026 June files' bare `HOM` (holding-order match) or the words. */
const HOLDING_ORDER = /\bHOM?\b|holding order/i;

/** A holding order number column holds the number, `HO match` or the words; `N/A` and `n/a*` name none. */
const namesHoldingOrder = (value: string): boolean => /\d/.test(value) || HOLDING_ORDER.test(value);

function schemeOf(category: string): Scheme {
  const text = category.toLowerCase();
  if (text.startsWith('surveillance')) return 'surveillance';
  if (text.startsWith('risk')) return 'risk';
  return null;
}

/** "N/A" units mean there are none. */
const NO_UNITS = /^n\/a$/i;

/** A result and its units as one text: `Detected` and `/125g` give `Detected/125g`, `11` and `mg/kg` give `11 mg/kg`. */
function withUnits(result: string, units: string): string {
  if (units === '' || NO_UNITS.test(units)) return result;
  if (result === '') return units;
  return units.startsWith('/') ? `${result}${units}` : `${result} ${units}`;
}

/** A cell whose text runs on into the row below: `Keeramin` and `(dried fish)` give `Keeramin (dried fish)`. */
const runOn = (text: string, more: string): string => (more === '' ? text : text === '' ? more : `${text} ${more}`);

/** A record being built: its first row plus what its continuation rows add. */
interface Draft {
  failedOn: string | null;
  product: string;
  country: string;
  producer: string;
  tests: string[];
  reasons: string[];
  results: string[];
  category: string;
  holdingOrder: string;
  /** The scheme its table's title names. */
  tableScheme: Scheme;
  /** True when its table has separate test and reason columns. */
  separate: boolean;
}

/**
 * Reads one monthly file, table by table (see `tablesOf`). Headers are matched by alias after trimming and
 * lower-casing; a value under no header fails. Fully blank rows are skipped. A row with no date that lacks a product, a
 * country or a producer continues the record above it: its tests, reasons and results add to the record's, and its
 * product, country and producer text runs on from the record's (2020 files split long cells over two rows). A row with
 * no date but all three is a record without a date. The scheme comes from the category column, or else from the
 * table's title.
 *
 * The key hashes the month, the record's identifying fields, its first test (and its first reason, when the table has
 * a reason column of its own) and its position among records that are otherwise identical; the results are left out so
 * a corrected result keeps the key. Any other correction gives a new key, which the sync pairs with the key it replaces
 * and updates in place (see `syncMonthlyFiles`).
 */
export function parseAuCsv(csv: string, reportMonth: string): AuRecord[] {
  const rows = parse(csv, { bom: true, skip_empty_lines: true, relax_column_count: true }) as string[][];

  const drafts: Draft[] = [];
  for (const table of tablesOf(rows)) {
    const columns = withTestColumn(table);
    const named = new Set(columns.values());
    const separate = columns.get('test') !== columns.get('reason');
    for (const { cells, where } of table.rows) {
      const stray = cells.findIndex((cell, index) => cell !== '' && !named.has(index));
      if (stray !== -1) throw new Error(`${ERROR} ${where} has a value under no header: "${cells[stray]}"`);
      const cell = (field: AuField): string => {
        const index = columns.get(field);
        return index === undefined ? '' : (cells[index] ?? '');
      };
      const [date, product, country, producer] = [cell('failedOn'), cell('product'), cell('country'), cell('producer')];
      const [test, reason, result] = [cell('test'), cell('reason'), withUnits(cell('result'), cell('units'))];

      if (date === '' && (product === '' || country === '' || producer === '')) {
        if ([product, country, producer, test, reason, result].every((value) => value === '')) continue;
        const previous = drafts[drafts.length - 1];
        if (previous === undefined) throw new Error(`${ERROR} ${where} continues a record, but there is none above it`);
        previous.product = runOn(previous.product, product);
        previous.country = runOn(previous.country, country);
        previous.producer = runOn(previous.producer, producer);
        if (test !== '') previous.tests.push(test);
        if (reason !== '') previous.reasons.push(reason);
        if (result !== '') previous.results.push(result);
        continue;
      }

      if (product === '') throw new Error(`${ERROR} ${where} has no product description`);
      let failedOn: string | null = null;
      if (date !== '') {
        failedOn = parseDate(date);
        if (failedOn === null) throw new Error(`${ERROR} ${where} has a date that is neither D/MM/YYYY nor an Excel day number: "${date}"`);
      }
      drafts.push({
        failedOn,
        product,
        country,
        producer,
        tests: test === '' ? [] : [test],
        reasons: reason === '' ? [] : [reason],
        results: result === '' ? [] : [result],
        category: cell('category'),
        holdingOrder: cell('holdingOrder'),
        tableScheme: table.scheme,
        separate,
      });
    }
  }

  const seen = new Map<string, number>();
  return drafts.map((draft): AuRecord => {
    const failure = draft.separate ? [draft.tests[0] ?? '', draft.reasons[0] ?? ''] : [draft.tests[0] ?? ''];
    const identity = JSON.stringify([reportMonth, draft.failedOn ?? '', draft.product, draft.producer, draft.country, ...failure]);
    const ordinal = seen.get(identity) ?? 0;
    seen.set(identity, ordinal + 1);
    const sourceKey = createHash('sha256').update(`${identity}|${ordinal}`).digest('hex').slice(0, 40);

    const producerName = orNull(draft.producer);
    return {
      sourceKey,
      reportMonth,
      failedOn: draft.failedOn,
      productDesc: draft.product,
      countryCode: countryFromName(draft.country),
      producerName,
      nameNorm: producerName === null ? '' : normalizeName(producerName).primary,
      testApplied: draft.tests.join(TEST_SEPARATOR),
      reason: draft.reasons.join(TEST_SEPARATOR),
      resultText: draft.results.length === 0 ? null : draft.results.join(TEST_SEPARATOR),
      holdingOrderMatch: HOLDING_ORDER.test(draft.category) || namesHoldingOrder(draft.holdingOrder) ? true : null,
      scheme: schemeOf(draft.category) ?? draft.tableScheme,
    };
  });
}

const parts = (text: string): string[] => (text === '' ? [] : text.split(TEST_SEPARATOR));

/** The failed tests of a record, in file order. */
export const testsOf = (r: Pick<AuRecord, 'testApplied'>): string[] => parts(r.testApplied);

/** The reasons for fail of a record, in file order. */
export const reasonsOf = (r: Pick<AuRecord, 'reason'>): string[] => parts(r.reason);

/** The commodity comes from the product description; every failed test and every reason is a hazard text of its own. */
export function classifyAu(rules: RuleSet, r: AuRecord): { commodityId: number; hazardIds: number[] } {
  return {
    commodityId: classifyCommodity(rules, 'au_ifis', { product_desc: r.productDesc }),
    hazardIds: classifyHazards(rules, 'au_ifis', { test: testsOf(r), reason: reasonsOf(r) }),
  };
}
