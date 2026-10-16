import { FillRateCounter, type FillRates } from './fill-rate';
import { normalizeHeader } from './read-csv-summary';

export interface RecordsSummary {
  /** Field names in first-seen order, spelled as the source spells them. */
  fields: string[];
  rows: number;
  fillRates: FillRates;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Empty strings, null, empty arrays and empty objects count as "not filled". */
function cellText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.length === 0 ? undefined : JSON.stringify(value);
  if (typeof value === 'object') return Object.keys(value).length === 0 ? undefined : JSON.stringify(value);
  return String(value);
}

function lowerKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [normalizeHeader(key), value]));
}

export function extractRecords(body: unknown, jsonPath?: string): unknown[] {
  let current: unknown = body;
  for (const part of (jsonPath ?? '').split('.').filter(Boolean)) {
    if (!isPlainObject(current) || !(part in current)) {
      throw new Error(`JSON path "${jsonPath}" not found (stopped at "${part}")`);
    }
    current = current[part];
  }
  if (Array.isArray(current)) return current;
  const found = isPlainObject(current) ? Object.keys(current).join(', ') : typeof current;
  throw new Error(`Expected an array of records${jsonPath ? ` at "${jsonPath}"` : ''}; found keys: ${found}`);
}

export function summarizeRecords(records: readonly unknown[], fillRateFields: readonly string[]): RecordsSummary {
  const fields: string[] = [];
  const seen = new Set<string>();
  const counter = new FillRateCounter(fillRateFields.map(normalizeHeader));
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    const row: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(record)) {
      const name = normalizeHeader(key);
      if (!seen.has(name)) {
        seen.add(name);
        fields.push(key);
      }
      row[name] = cellText(value);
    }
    counter.add(row);
  }
  const { total, rates } = counter.result();
  return { fields, rows: total, fillRates: rates };
}

/** How many records repeat a key already seen; the key is the listed fields together. */
export function countDuplicateKeys(records: readonly unknown[], keyFields: readonly string[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    const lower = lowerKeys(record);
    const key = keyFields.map((field) => String(lower[normalizeHeader(field)] ?? '')).join('\u0001');
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return duplicates;
}
