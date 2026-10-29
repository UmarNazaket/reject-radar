import { HttpStatus } from '@nestjs/common';
import { BULK_LIMITS, type BulkDelimiter } from '@rejectradar/contracts';
import { normalizeCountry } from '@rejectradar/matching';
import { parse } from 'csv-parse';
import { pipeline, Readable } from 'node:stream';
import { AppError } from '../common/errors';

export interface BulkInputRow {
  /** 1-based number of the row under the header, blank rows counted too, so it matches the user's sheet (P6-D3). */
  rowNr: number;
  name: string;
  /** ISO 3166-1 alpha-2, resolved from a code or a name. */
  countryCode: string;
  city: string | null;
  fei: string | null;
}

/** What the parser returns: the rows, and the delimiter the file used, which its export is written in too (P6-D9). */
export interface ParsedBulkCsv {
  rows: BulkInputRow[];
  delimiter: BulkDelimiter;
}

export type BulkRowProblem = 'required' | 'too_short' | 'too_long' | 'unknown_country' | 'not_digits';

const REQUIRED_COLUMNS = ['name', 'country'] as const;

const encodingError = () =>
  new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ENCODING', 'The file is not UTF-8. Save it as "CSV UTF-8" and upload it again');

/**
 * A file csv-parse cannot read, with the line it reports when it reports one. An unclosed quote runs on to the end of the
 * file, so for that one the line is where the file ends: the quote opened somewhere above it.
 */
const notCsvError = (line: unknown) =>
  new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ROWS', typeof line === 'number' ? `The file is not valid CSV (line ${line})` : 'The file is not valid CSV', {
    count: 0,
    problems: [],
    ...(typeof line === 'number' ? { line } : {}),
  });

/** The delimiter is decided by the header line: `;` when it has a `;` and no `,` (Excel in a comma-decimal locale), else `,` (P6-D2). */
function delimiterOf(headerLine: string): BulkDelimiter {
  return headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
}

/**
 * The first line of `text` that is not blank, once it is whole: a line break follows it, or the file has `ended` (then it is
 * `''` if every line is blank). Null while more text is needed. `trim` drops a BOM too, so a BOM alone on a line is blank.
 */
function firstLine(text: string, ended: boolean): string | null {
  const lines = text.split(/\r\n|\r|\n/);
  // The last piece is unfinished until the file ends.
  const whole = ended ? lines : lines.slice(0, -1);
  return whole.find((line) => line.trim() !== '') ?? (ended ? '' : null);
}

/**
 * Reads an uploaded CSV as it arrives (P6-D2, P6-D3). The bytes are counted before they are decoded, so a file over the
 * limit stops the read at once, and only the parsed rows are kept. Every row is checked before anything is returned:
 * one bad row rejects the file with the problems found.
 */
export async function parseBulkCsv(body: AsyncIterable<Buffer>, limits: typeof BULK_LIMITS = BULK_LIMITS): Promise<ParsedBulkCsv> {
  const iterator = body[Symbol.asyncIterator]();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;

  /** Counts the chunk, then decodes it; `null` flushes the decoder at the end of the file. */
  const decode = (chunk: Buffer | null): string => {
    if (chunk) {
      bytes += chunk.length;
      if (bytes > limits.maxBytes) {
        throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'FILE_TOO_LARGE', `The file is larger than ${limits.maxBytes / (1024 * 1024)} MB`);
      }
    }
    try {
      return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    } catch {
      throw encodingError();
    }
  };

  // Read up to the end of the first line that is not blank, the header, which decides the delimiter.
  let head = '';
  let ended = false;
  try {
    while (firstLine(head, false) === null) {
      const next = await iterator.next();
      if (next.done) {
        head += decode(null);
        ended = true;
        break;
      }
      head += decode(next.value);
    }
  } catch (error) {
    await iterator.return?.().catch(() => undefined);
    throw error;
  }

  async function* texts(): AsyncGenerator<string> {
    try {
      yield head;
      if (ended) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const text = decode(next.value);
        if (text) yield text;
      }
      const rest = decode(null);
      if (rest) yield rest;
    } finally {
      // Reached early (a limit hit, or an error): release the body without reading the rest of it.
      if (!ended) await iterator.return?.().catch(() => undefined);
    }
  }

  const delimiter = delimiterOf(firstLine(head, true) ?? '');
  const parser = parse({
    delimiter,
    bom: true,
    // Blank lines come through as records, so the row numbers count them as the sheet does; they are skipped below.
    skip_empty_lines: false,
    relax_column_count: true,
    relax_quotes: true,
  });
  pipeline(Readable.from(texts()), parser, () => undefined);

  const rows: BulkInputRow[] = [];
  const problems: { row: number; column: string; problem: BulkRowProblem }[] = [];
  let problemCount = 0;
  let columns: { name: number; country: number; city: number; fei: number } | null = null;
  /** Records under the header, blank ones included: the row numbers the user sees. */
  let recordNr = 0;
  /** Records with something in them; the row limit counts these only. */
  let dataRows = 0;

  const problem = (row: number, column: string, kind: BulkRowProblem) => {
    problemCount++;
    if (problems.length < limits.maxProblems) problems.push({ row, column, problem: kind });
  };

  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      // A blank line, or a row of empty cells (Excel's `;;;` under the data).
      const blank = record.every((value) => value.trim() === '');
      if (!columns) {
        if (blank) continue;
        const header = record.map((cell) => cell.trim().toLowerCase());
        const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
        if (missing.length > 0) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_HEADER', 'The first row must name the columns, and it needs at least name and country', { missing });
        }
        columns = { name: header.indexOf('name'), country: header.indexOf('country'), city: header.indexOf('city'), fei: header.indexOf('fei') };
        continue;
      }
      recordNr++;
      if (blank) continue;
      dataRows++;
      if (dataRows > limits.maxRows) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_ROWS', `The file has more than ${limits.maxRows} rows`);
      }
      const cell = (index: number) => (index < 0 ? '' : (record[index] ?? '').trim());
      const name = cell(columns.name);
      const country = cell(columns.country);
      const city = cell(columns.city);
      const fei = cell(columns.fei);
      if (!name) problem(recordNr, 'name', 'required');
      else if (name.length < 2) problem(recordNr, 'name', 'too_short');
      else if (name.length > limits.maxNameLength) problem(recordNr, 'name', 'too_long');
      if (city.length > limits.maxCityLength) problem(recordNr, 'city', 'too_long');
      const countryCode = country ? normalizeCountry(country) : null;
      if (!country) problem(recordNr, 'country', 'required');
      else if (!countryCode) problem(recordNr, 'country', 'unknown_country');
      if (fei && !/^\d{1,10}$/.test(fei)) problem(recordNr, 'fei', 'not_digits');
      if (problemCount === 0) rows.push({ rowNr: recordNr, name, countryCode: countryCode as string, city: city || null, fei: fei || null });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const { code, lines } = (error ?? {}) as { code?: unknown; lines?: unknown };
    if (typeof code === 'string' && code.startsWith('CSV_')) throw notCsvError(lines);
    throw error;
  }

  if (!columns) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_HEADER', 'The first row must name the columns, and it needs at least name and country', {
      missing: [...REQUIRED_COLUMNS],
    });
  }
  if (dataRows === 0) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ROWS', 'The file has no rows under the header', { count: 0, problems: [] });
  }
  if (problemCount > 0) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ROWS', `${problemCount} problem${problemCount === 1 ? '' : 's'} found in the file; nothing was imported`, {
      count: problemCount,
      problems,
    });
  }
  return { rows, delimiter };
}
