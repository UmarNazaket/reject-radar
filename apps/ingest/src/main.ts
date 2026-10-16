import { Command, Option } from 'commander';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { formatProbeReport, probePage } from './verify/probe-page';
import { SOURCE_NAMES } from './verify/sources';
import { verifySource } from './verify/verify-source';

if (existsSync('.env')) process.loadEnvFile('.env');

const list = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const collect = (value: string, previous: string[]) => [...previous, value];

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
    const result = await verifySource(options);
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
  .option('--sample-count <n>', 'how many samples to show', (value: string) => Number.parseInt(value, 10), 3)
  .option('--report <path>', 'markdown file to append the result to')
  .action(async (options) => {
    const result = await probePage(options);
    console.log(JSON.stringify(result, null, 2));
    if (options.report) {
      await mkdir(path.dirname(options.report), { recursive: true });
      await appendFile(options.report, formatProbeReport(result), 'utf8');
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
