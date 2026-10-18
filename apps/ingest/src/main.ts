import type { IngestEnv } from '@rejectradar/contracts';
import { Command, InvalidArgumentError, Option } from 'commander';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openDb } from './core/db';
import { loadIngestEnv } from './core/env';
import { createFetcher } from './core/http';
import { databaseSizeBytes, SIZE_LIMIT_BYTES, toMegabytes } from './core/size-check';
import { formatProbeReport, probePage } from './verify/probe-page';
import { SOURCE_NAMES } from './verify/sources';
import { verifySource } from './verify/verify-source';

const list = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const collect = (value: string, previous: string[]) => [...previous, value];
const positiveInt = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError('Must be a positive integer.');
  return Number.parseInt(value, 10);
};

/** The polite fetcher every command uses; its contact address comes from the validated environment. */
const fetcherFor = (env: IngestEnv) => createFetcher({ contact: env.INGEST_CONTACT_EMAIL });

const program = new Command().name('rejectradar-ingest').description('RejectRadar data ingestion CLI');

program
  .command('verify-source')
  .description('Check a source: fields, rows, fill rates, duplicate keys (spec §18 V1, V3–V6)')
  .addOption(new Option('--source <name>', 'source to verify').choices(SOURCE_NAMES).makeOptionMandatory())
  .option('--url <url>', 'download URL (csv and json sources)')
  .option('--file <path>', 'local file instead of --url')
  .option('--json-path <path>', 'dot path to the records array in a JSON response')
  .option('--from <date>', 'first RefusalDate, YYYY-MM-DD (fda_refusals)')
  .option('--to <date>', 'last RefusalDate, YYYY-MM-DD (fda_refusals)')
  .option('--fill-rate <fields>', 'comma-separated fields to measure', list)
  .option('--unique <fields>', 'comma-separated fields that should form a unique key (json sources)', list)
  .option('--report <path>', 'markdown file to append the result to')
  .action(async (options) => {
    // A local --file needs no network, so it needs no environment either.
    const env = options.file ? undefined : loadIngestEnv();
    const result = await verifySource({
      ...options,
      env: { FDA_API_USER: env?.FDA_API_USER, FDA_API_KEY: env?.FDA_API_KEY },
      fetcher: env && fetcherFor(env),
    });
    console.log(JSON.stringify({ ...result, sample: result.sample ? '(first record in the report)' : null }, null, 2));
    if (result.missing.length > 0) process.exitCode = 2;
  });

program
  .command('probe-page')
  .description('Download a page and count pattern matches (spec §18 V2, V6)')
  .option('--url <url>', 'page URL')
  .option('--file <path>', 'saved page instead of --url')
  .option('--count <regex>', 'pattern to count, case-insensitive (repeatable)', collect, [])
  .option('--sample <regex>', 'pattern whose first matches are shown')
  .option('--sample-count <n>', 'how many samples to show', positiveInt, 3)
  .option('--report <path>', 'markdown file to append the result to')
  .action(async (options) => {
    const env = options.file ? undefined : loadIngestEnv();
    const result = await probePage(options, env && fetcherFor(env));
    console.log(JSON.stringify(result, null, 2));
    if (options.report) {
      await mkdir(path.dirname(options.report), { recursive: true });
      await appendFile(options.report, formatProbeReport(result), 'utf8');
    }
  });

program
  .command('db:size-check')
  .description('Print the database size; exit 1 at or above the 900 MB limit (spec §6.3)')
  .action(async () => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      const size = await databaseSizeBytes(db);
      console.log(`Database size: ${toMegabytes(size)} MB (limit ${toMegabytes(SIZE_LIMIT_BYTES)} MB)`);
      if (size >= SIZE_LIMIT_BYTES) process.exitCode = 1;
    } finally {
      await close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
