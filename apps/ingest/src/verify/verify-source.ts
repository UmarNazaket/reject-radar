import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Fetcher } from '../core/http';
import { FDA_REFUSALS_URL, fetchRefusalsPage } from './fda-api';
import { downloadFile, ensureCsv, sha256File, sha256Text } from './fetch-file';
import { checkFields } from './field-check';
import type { FillRates } from './fill-rate';
import { readCsvSummary } from './read-csv-summary';
import { SOURCES, type SourceName, type SourceSpec } from './sources';
import { countDuplicateKeys, extractRecords, summarizeRecords } from './summarize-records';

export interface VerifyOptions {
  source: SourceName;
  url?: string;
  file?: string;
  jsonPath?: string;
  from?: string;
  to?: string;
  fillRate?: string[];
  unique?: string[];
  report?: string;
  workDir?: string;
  env?: Record<string, string | undefined>;
  /** Required for anything fetched over the network (--url and fda_refusals). */
  fetcher?: Fetcher;
}

export interface VerifyResult {
  source: SourceName;
  origin: string;
  sha256: string;
  rows: number;
  /** Total the source reports (FDA only); null when unknown. */
  total: number | null;
  fields: string[];
  missing: string[];
  extra: string[];
  fillRates: FillRates;
  /** Records whose `unique` key repeats; null when no key was given or the source is CSV. */
  duplicates: number | null;
  /** First record as JSON, cut to 2,000 characters; null for CSV sources. */
  sample: string | null;
}

interface Loaded {
  origin: string;
  sha256: string;
  fields: string[];
  rows: number;
  total: number | null;
  fillRates: FillRates;
  records: unknown[] | null;
}

export async function verifySource(options: VerifyOptions): Promise<VerifyResult> {
  const spec: SourceSpec = SOURCES[options.source];
  const fillRate = options.fillRate && options.fillRate.length > 0 ? options.fillRate : spec.fillRate;
  const loaded = spec.kind === 'fda-api' ? await loadFda(options, fillRate) : await loadFile(options, spec, fillRate);
  const { missing, extra } = checkFields(loaded.fields, spec.expected);
  const result: VerifyResult = {
    source: options.source,
    origin: loaded.origin,
    sha256: loaded.sha256,
    rows: loaded.rows,
    total: loaded.total,
    fields: loaded.fields,
    missing,
    extra,
    fillRates: loaded.fillRates,
    duplicates: loaded.records && options.unique && options.unique.length > 0 ? countDuplicateKeys(loaded.records, options.unique) : null,
    sample: loaded.records && loaded.records.length > 0 ? JSON.stringify(loaded.records[0]).slice(0, 2000) : null,
  };
  if (options.report) {
    await mkdir(path.dirname(options.report), { recursive: true });
    await appendFile(options.report, formatReport(result), 'utf8');
  }
  return result;
}

async function loadFda(options: VerifyOptions, fillRate: readonly string[]): Promise<Loaded> {
  const env = options.env ?? process.env;
  const user = env['FDA_API_USER']?.trim();
  const key = env['FDA_API_KEY']?.trim();
  if (!user || !key) throw new Error('Set FDA_API_USER and FDA_API_KEY in .env (see .env.example and account check A9)');
  if (!options.from || !options.to) throw new Error('Pass --from and --to (YYYY-MM-DD) for fda_refusals');
  if (!options.fetcher) throw new Error('verifySource needs a fetcher to call the FDA API');
  const page = await fetchRefusalsPage(options.fetcher, { user, key }, { from: options.from, to: options.to, countTotal: true });
  const summary = summarizeRecords(page.records, fillRate);
  return {
    origin: `${FDA_REFUSALS_URL} (RefusalDate ${options.from} to ${options.to}, first page)`,
    sha256: sha256Text(JSON.stringify(page.records)),
    fields: summary.fields,
    rows: summary.rows,
    total: page.total,
    fillRates: summary.fillRates,
    records: page.records,
  };
}

async function loadFile(options: VerifyOptions, spec: SourceSpec, fillRate: readonly string[]): Promise<Loaded> {
  const workDir = options.workDir ?? path.resolve('tmp/verify');
  let downloaded: string;
  if (options.file) downloaded = options.file;
  else if (options.url) {
    if (!options.fetcher) throw new Error('verifySource needs a fetcher to download --url');
    downloaded = await downloadFile(options.fetcher, options.url, workDir, spec.kind === 'json' ? 'json' : 'csv');
  }
  else throw new Error('Pass --url <download url> or --file <local file>');
  const origin = options.url ?? downloaded;
  const sha256 = await sha256File(downloaded);

  if (spec.kind === 'json') {
    const records = extractRecords(parseJsonFile(await readFile(downloaded, 'utf8'), downloaded), options.jsonPath);
    const summary = summarizeRecords(records, fillRate);
    return { origin, sha256, fields: summary.fields, rows: summary.rows, total: null, fillRates: summary.fillRates, records };
  }

  const csvPath = await ensureCsv(downloaded, workDir);
  const summary = await readCsvSummary(createReadStream(csvPath), fillRate);
  return { origin, sha256, fields: summary.headers, rows: summary.rows, total: null, fillRates: summary.fillRates, records: null };
}

function parseJsonFile(text: string, file: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function formatReport(result: VerifyResult, at: Date = new Date()): string {
  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  const list = (items: readonly string[]) => (items.length ? items.map((item) => `\`${item}\``).join(', ') : 'none');
  const fill = Object.entries(result.fillRates).map(([field, value]) => `\`${field}\` ${pct(value)}`).join(', ') || 'n/a';
  const rows = `${result.rows.toLocaleString('en-US')}${
    result.total === null ? '' : ` (the source reports ${result.total.toLocaleString('en-US')} in total)`
  }`;
  return [
    `## ${result.source} — ${at.toISOString()}`,
    '',
    `- Origin: ${result.origin}`,
    `- SHA-256: \`${result.sha256}\``,
    `- Rows read: ${rows}`,
    `- Fields: ${list(result.fields)}`,
    `- Missing expected fields: ${list(result.missing)}`,
    `- Extra fields: ${list(result.extra)}`,
    `- Fill rates: ${fill}`,
    ...(result.duplicates === null ? [] : [`- Duplicate keys: ${result.duplicates}`]),
    ...(result.sample ? ['- First record:', '', '```json', result.sample, '```'] : []),
    '',
    '',
  ].join('\n');
}
