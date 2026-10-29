import { HttpStatus } from '@nestjs/common';
import { BULK_LIMITS } from '@rejectradar/contracts';
import { normalizeCountry } from '@rejectradar/matching';
import { parse } from 'csv-parse';
import { pipeline, Readable } from 'node:stream';
import { AppError } from '../common/errors';

export interface BulkInputRow {
  /** 1-based number of the data row, counting from the first row under the header. */
  rowNr: number;
  name: string;
  /** ISO 3166-1 alpha-2, resolved from a code or a name. */
  countryCode: string;
  city: string | null;
  fei: string | null;
}

export type BulkRowProblem = 'required' | 'too_short' | 'unknown_country' | 'not_digits';

const REQUIRED_COLUMNS = ['name', 'country'] as const;

const encodingError = () =>
  new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ENCODING', 'The file is not UTF-8. Save it as "CSV UTF-8" and upload it again');

const notCsvError = () =>
  new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ROWS', 'The file is not valid CSV', { count: 0, problems: [] });

/** The delimiter is decided by the header line: `;` when it has a `;` and no `,` (Excel in a comma-decimal locale), else `,` (P6-D2). */
function delimiterOf(headerLine: string): ',' | ';' {
  return headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
}

const firstLineBreak = (text: string) => text.search(/[\r\n]/);

/**
 * Reads an uploaded CSV as it arrives (P6-D2, P6-D3). The bytes are counted before they are decoded, so a file over the
 * limit stops the read at once, and only the parsed rows are kept. Every row is checked before anything is returned:
 * one bad row rejects the file with the problems found.
 */
export async function parseBulkCsv(body: AsyncIterable<Buffer>, limits: typeof BULK_LIMITS = BULK_LIMITS): Promise<BulkInputRow[]> {
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

  // Read up to the end of the header line, which decides the delimiter.
  let head = '';
  let ended = false;
  try {
    while (firstLineBreak(head) < 0) {
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

  const parser = parse({
    delimiter: delimiterOf(head.split(/[\r\n]/, 1)[0]),
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  pipeline(Readable.from(texts()), parser, () => undefined);

  const rows: BulkInputRow[] = [];
  const problems: { row: number; column: string; problem: BulkRowProblem }[] = [];
  let problemCount = 0;
  let columns: { name: number; country: number; city: number; fei: number } | null = null;
  let dataRows = 0;

  const problem = (row: number, column: string, kind: BulkRowProblem) => {
    problemCount++;
    if (problems.length < limits.maxProblems) problems.push({ row, column, problem: kind });
  };

  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      if (!columns) {
        const header = record.map((cell) => cell.trim().toLowerCase());
        const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
        if (missing.length > 0) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_HEADER', 'The first row must name the columns, and it needs at least name and country', { missing });
        }
        columns = { name: header.indexOf('name'), country: header.indexOf('country'), city: header.indexOf('city'), fei: header.indexOf('fei') };
        continue;
      }
      const cell = (index: number) => (index < 0 ? '' : (record[index] ?? '').trim());
      // A row of empty cells (Excel's `;;;` under the data) is a blank line.
      if (record.every((value) => value.trim() === '')) continue;
      dataRows++;
      if (dataRows > limits.maxRows) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_ROWS', `The file has more than ${limits.maxRows} rows`);
      }
      const name = cell(columns.name);
      const country = cell(columns.country);
      const city = cell(columns.city);
      const fei = cell(columns.fei);
      if (!name) problem(dataRows, 'name', 'required');
      else if (name.length < 2) problem(dataRows, 'name', 'too_short');
      const countryCode = country ? normalizeCountry(country) : null;
      if (!country) problem(dataRows, 'country', 'required');
      else if (!countryCode) problem(dataRows, 'country', 'unknown_country');
      if (fei && !/^\d{1,10}$/.test(fei)) problem(dataRows, 'fei', 'not_digits');
      if (problemCount === 0) rows.push({ rowNr: dataRows, name, countryCode: countryCode as string, city: city || null, fei: fei || null });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (typeof (error as { code?: unknown })?.code === 'string' && (error as { code: string }).code.startsWith('CSV_')) throw notCsvError();
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
  return rows;
}
