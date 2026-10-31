import type { IngestEnv } from '@rejectradar/contracts';
import { LABELLED_PAIR_COLUMNS, linkEntities, samplePairs, sampleSummary, toCsv } from '@rejectradar/entities';
import { createMailTransport, Mailer } from '@rejectradar/mail';
import { Command, InvalidArgumentError, Option } from 'commander';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadMailEnv } from './alerts/mail-env';
import { runAlerts } from './alerts/run-alerts';
import { sendDigests } from './alerts/send-digests';
import { openDb } from './core/db';
import { describeError } from './core/errors';
import { loadIngestEnv } from './core/env';
import { createDeps, utcToday } from './core/deps';
import { createFetcher } from './core/http';
import { assertBelowSizeLimit, databaseSizeBytes, SIZE_LIMIT_BYTES, toMegabytes } from './core/size-check';
import { backupApp, restoreApp } from './maintenance/backup';
import { purge } from './maintenance/purge';
import { syncChargeCodes } from './sync/fda/charge-codes';
import { syncAuIfis } from './sync/au-ifis/sync';
import { syncEuMrl } from './sync/eu-mrl/sync';
import { syncFdaRefusals } from './sync/fda/refusals';
import { crawlNotDue, syncImportAlerts } from './sync/import-alerts/sync';
import { DEFAULT_DETAILS_LIMIT, syncRasff } from './sync/rasff/sync';
import { remapIfRequested, remapTaxonomy } from './sync/remap';
import { draftSummaries } from './summaries/draft';
import { createClaude } from './summaries/claude';
import { loadSummaryEnv } from './summaries/summary-env';
import { translateSummaries } from './summaries/translate';
import { syncUkBn } from './sync/uk-bn/sync';
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

const isoDate = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new InvalidArgumentError('Use a date as YYYY-MM-DD.');
  return value;
};

/** Opens the database and rules, runs a sync and always closes the connection pool. */
async function withDeps<T>(env: IngestEnv, run: (deps: Awaited<ReturnType<typeof createDeps>>) => Promise<T>): Promise<T> {
  const deps = await createDeps(env);
  try {
    return await run(deps);
  } finally {
    await deps.close();
  }
}

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
  .command('sync:fda-charge-codes')
  .description('Load FDA charge codes (the reference file behind RefusalCharges) with their hazards')
  .option('--no-events', 'accepted so every sync:* takes it; this reference sync never emits change events (P2-D6)')
  .action(async () => {
    const env = loadIngestEnv();
    const result = await withDeps(env, (deps) => syncChargeCodes(deps));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('sync:fda-refusals')
  .description('Sync FDA import refusals of food and feed (default: the last 120 days)')
  .option('--from <date>', 'first RefusalDate, YYYY-MM-DD', isoDate)
  .option('--to <date>', 'last RefusalDate, YYYY-MM-DD', isoDate)
  .option('--no-events', 'write the rows but emit no change events (backfills; a first load suppresses them by itself)')
  .action(async (options: { from?: string; to?: string; events: boolean }) => {
    const env = loadIngestEnv();
    if (!env.FDA_API_USER || !env.FDA_API_KEY) {
      throw new Error('sync:fda-refusals needs FDA_API_USER and FDA_API_KEY in the environment (FDA OII Unified Logon, see .env.example).');
    }
    const creds = { user: env.FDA_API_USER, key: env.FDA_API_KEY };
    const result = await withDeps(env, (deps) => syncFdaRefusals({ ...deps, creds }, options));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('sync:import-alerts')
  .description('Sync FDA Import Alerts (food alerts only): the Red and Green Lists, with the two-run delisting rule')
  .option('--no-events', 'write the rows but emit no change events (backfills; a first load suppresses them by itself)')
  .option('--only <numbers>', 'comma-separated alert numbers to crawl, e.g. 99-19,16-131 (manual checks; allowed outside the visiting hours)', list)
  .option('--force-hours', 'start a full crawl outside the FDA robots.txt visiting hours (03:00-09:00 UTC)')
  .option('--if-due', 'for scheduled runs: skip, without failing, outside the visiting hours or when a full crawl already succeeded today (UTC)')
  .action(async (options: { events: boolean; only?: string[]; forceHours?: boolean; ifDue?: boolean }) => {
    const env = loadIngestEnv();
    const result = await withDeps(env, async (deps) => {
      const notDue = options.ifDue ? await crawlNotDue(deps.db, new Date()) : null;
      return notDue ? { skipped: notDue } : syncImportAlerts({ ...deps, failureDir: env.INGEST_FAILURE_DIR }, options);
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('sync:rasff')
  .description('Sync EU RASFF notifications of food and feed from the RASFF Window, with hazard details')
  .option('--from <date>', 'oldest notification date to read, YYYY-MM-DD (default: 30 days before the newest stored one)', isoDate)
  .option('--details-limit <n>', 'most notification details to fetch in this run', positiveInt, DEFAULT_DETAILS_LIMIT)
  .option('--no-events', 'write the rows but emit no change events (backfills; a first load suppresses them by itself)')
  .action(async (options: { from?: string; detailsLimit: number; events: boolean }) => {
    const env = loadIngestEnv();
    const result = await withDeps(env, (deps) => syncRasff(deps, options));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('sync:uk-bn')
  .description('Sync UK FSA border notifications: the monthly CSV files listed on data.gov.uk, loading new or changed files by SHA-256')
  .option('--no-events', 'write the rows but emit no change events (backfills; a first load suppresses them by itself)')
  .action(async (options: { events: boolean }) => {
    const env = loadIngestEnv();
    const result = await withDeps(env, (deps) => syncUkBn(deps, options));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('sync:au-ifis')
  .description('Sync Australian Imported Food Inspection Scheme failing-food reports: the monthly CSV files listed on data.gov.au, loading new or changed files by SHA-256')
  .option('--no-events', 'write the rows but emit no change events (backfills; a first load suppresses them by itself)')
  .action(async (options: { events: boolean }) => {
    const env = loadIngestEnv();
    const result = await withDeps(env, (deps) => syncAuIfis(deps, options));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('sync:eu-mrl')
  .description('Refresh the EU pesticide maximum residue limits from the 8 XML files of the EU Pesticides Database (full replace, no events)')
  .option('--no-events', 'accepted so every sync:* takes it; this reference sync never emits change events (P2-D6)')
  .action(async () => {
    const env = loadIngestEnv();
    const result = await withDeps(env, (deps) => syncEuMrl(deps));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('taxonomy:remap')
  .description('Re-apply the taxonomy rules to every stored record and its notice after a rule was added or changed (emits no events)')
  .option('--if-requested', 'only when staff asked for a remap on the admin screen since the last one')
  .action(async (options: { ifRequested?: boolean }) => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      const result = options.ifRequested ? await remapIfRequested(db) : await remapTaxonomy(db);
      console.log(JSON.stringify(result ?? { skipped: 'no remap was requested' }, null, 2));
    } finally {
      await close();
    }
  });

program
  .command('entities:link')
  .description('Link unlinked FDA refusals, Import Alert listings and Australian producers to firms, then refresh firm facts (spec §8.2)')
  .option('--today <date>', 'the date the 12-month and 3-year counts are measured back from, YYYY-MM-DD (default: today, UTC)', isoDate)
  .action(async (options: { today?: string }) => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      // Spec §6.3: linking writes too, so a database at or over the limit stops it as it stops every sync.
      await assertBelowSizeLimit(db);
      const result = await linkEntities(db, { today: options.today ?? utcToday() });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await close();
    }
  });

program
  .command('alerts:run')
  .description('Turn new change events into alerts for the accounts that watch them, then send the instant emails for high-severity ones (spec §11). Exits 3 when a firm-level event has stayed unlinked for 48 hours')
  .option('--no-email', 'create the alerts but send no email (and need no mail variables)')
  .option('--batch-size <n>', 'events per transaction', positiveInt, 1000)
  .action(async (options: { email: boolean; batchSize: number }) => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      let mailer: Mailer | null = null;
      let appOrigin = '';
      if (options.email) {
        const mail = loadMailEnv();
        appOrigin = mail.APP_ORIGIN;
        mailer = new Mailer({
          db,
          transport: createMailTransport(mail),
          from: mail.MAIL_FROM,
          // The error can carry the address, so only the kind and the stage are logged.
          onError: ({ kind, stage }) => console.error(`alerts:run: ${kind} email ${stage} failed`),
        });
      }
      const result = await runAlerts({ db, mailer, appOrigin }, { batchSize: options.batchSize });
      console.log(JSON.stringify(result, null, 2));
      // Exit code 3 makes GitHub Actions email the owner: the cursor is stuck behind a record that never linked (P5-D14).
      if (result.failBlocked) process.exitCode = 3;
    } finally {
      await close();
    }
  });

program
  .command('digest:send')
  .description('Email the daily digests, and the weekly ones on Mondays (UTC): the unread alerts of each user since their last digest, grouped by firm and topic, in their language (spec §11)')
  .action(async () => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      const mail = loadMailEnv();
      const mailer = new Mailer({
        db,
        transport: createMailTransport(mail),
        from: mail.MAIL_FROM,
        // The error can carry the address, so only the kind and the stage are logged.
        onError: ({ kind, stage }) => console.error(`digest:send: ${kind} email ${stage} failed`),
      });
      const result = await sendDigests({ db, mailer, appOrigin: mail.APP_ORIGIN });
      console.log(JSON.stringify(result, null, 2));
      // A digest that could not be sent makes the run fail, so GitHub Actions emails the owner.
      if (result.failed > 0) process.exitCode = 1;
    } finally {
      await close();
    }
  });

program
  .command('summaries:draft')
  .description('Draft English summaries of the food Import Alerts whose text is new or changed, with Claude, for a person to approve (spec §9.10). Exits 1 when an alert could not be drafted')
  .option('--limit <n>', 'most alerts to draft in this run', positiveInt, 20)
  .option('--only <numbers>', 'only these alerts, e.g. 99-08,16-131', list)
  .action(async (options: { limit: number; only?: string[] }) => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      const result = await draftSummaries({ db, ...createClaude(loadSummaryEnv()) }, options);
      console.log(JSON.stringify(result, null, 2));
      if (result.failed.length + result.invalid.length > 0) process.exitCode = 1;
    } finally {
      await close();
    }
  });

program
  .command('summaries:translate')
  .description('Machine-translate approved English Import Alert summaries into Urdu, Hindi and Bengali, with Claude (spec §9.10). Exits 1 when a translation could not be made')
  .option('--limit <n>', 'most translations to make in this run', positiveInt, 30)
  .action(async (options: { limit: number }) => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      const result = await translateSummaries({ db, ...createClaude(loadSummaryEnv()) }, options);
      console.log(JSON.stringify(result, null, 2));
      if (result.failed.length + result.invalid.length > 0) process.exitCode = 1;
    } finally {
      await close();
    }
  });

program
  .command('entities:sample-pairs')
  .description('Write a CSV of record/firm pairs to label for the auto-link precision gate: link, review and near scores from at least 5 countries (spec §8.5)')
  .requiredOption('--out <path>', 'CSV file to write, e.g. libs/matching/test/fixtures/labelled-pairs.csv')
  .option('--count <n>', 'how many pairs to sample', positiveInt, 300)
  .option('--seed <n>', 'seed of the shuffle: the same data and seed give the same sample', positiveInt, 1)
  .action(async (options: { out: string; count: number; seed: number }) => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      // The whole sample is drawn before the file is written, so a run that fails leaves the file as it was.
      const rows = await samplePairs(db, { count: options.count, seed: options.seed });
      await mkdir(path.dirname(options.out), { recursive: true });
      await writeFile(options.out, toCsv(LABELLED_PAIR_COLUMNS, rows), 'utf8');
      console.log(JSON.stringify({ out: options.out, ...sampleSummary(rows) }));
    } finally {
      await close();
    }
  });

program
  .command('backup:app')
  .description('Write the account tables (not the reference data) to a gzipped file, one JSON line per row, from one read-only snapshot (P11)')
  .requiredOption('--out <file>', 'the file to write, e.g. backup-2026-11-01.ndjson.gz')
  .action(async (options: { out: string }) => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      console.log(JSON.stringify(await backupApp(db, options.out), null, 2));
    } finally {
      await close();
    }
  });

program
  .command('backup:restore')
  .description('Put a backup:app file back into a database on the same schema version with the reference data in place and empty account tables (P11)')
  .requiredOption('--file <file>', 'the decrypted backup:app file')
  .action(async (options: { file: string }) => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      console.log(JSON.stringify(await restoreApp(db, options.file), null, 2));
    } finally {
      await close();
    }
  });

program
  .command('maintenance:purge')
  .description('Apply the retention rules: bulk rows 30 days after their job finished, Paddle payloads, email logs and alert emails after 90 days, alerts after 365 days, used or expired tokens and invites after 30 days (spec §6.3, §7.2). Prints one count per rule, never row content')
  .action(async () => {
    const { db, close } = openDb(loadIngestEnv().DATABASE_URL);
    try {
      const counts = await purge(db);
      for (const [rule, count] of Object.entries(counts)) console.log(`${rule}: ${count}`);
    } finally {
      await close();
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

// The exit code is set rather than exiting at once: sockets still closing when `process.exit` runs trip a libuv
// assertion on Windows, which turns exit code 1 into 127.
program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? describeError(error) : error);
  process.exitCode = 1;
});
