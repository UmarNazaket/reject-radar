import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';
import { FillRateCounter, type FillRates } from './fill-rate';

export interface CsvSummary {
  headers: string[];
  rows: number;
  fillRates: FillRates;
}

export function normalizeHeader(header: string): string {
  return header.replace(/^\uFEFF/, '').trim().toLowerCase();
}

export async function readCsvSummary(input: Readable, fillRateColumns: readonly string[]): Promise<CsvSummary> {
  let headers: string[] = [];
  const counter = new FillRateCounter(fillRateColumns.map(normalizeHeader));
  const parser = input.pipe(
    parse({
      bom: true,
      columns: (raw: string[]) => {
        headers = raw.map(normalizeHeader);
        return headers;
      },
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    }),
  );
  for await (const record of parser) counter.add(record as Record<string, string | undefined>);
  const { total, rates } = counter.result();
  return { headers, rows: total, fillRates: rates };
}
