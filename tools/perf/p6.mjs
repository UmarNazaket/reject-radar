#!/usr/bin/env node
// Phase 6 measurements: a 1,000-row bulk job and the two PDF reports (roadmap P6; spec §9.8, §9.9, V11).
// Usage: node tools/perf/p6.mjs --base <url> --email <e> [--password <p>] --csv <file> [--firm <id>]... [--topic <dashboard query string>]...
//   The password may come from the P6_PASSWORD environment variable instead, which keeps it out of the shell history.
//   e.g. --topic "origin=PK&commodity=12"
// No dependencies: Node 20+ `fetch`. Exits 1 when the job takes over 180 s (for a file of up to 1,000 rows), when any PDF takes
// over 3 s, when any request fails, or when nothing was judged. It never prints the password or a cookie.

import { readFile } from 'node:fs/promises';

const JOB_BUDGET_S = 180; // spec §9.8: a 1,000-row file finishes in 3 minutes
const JOB_BUDGET_ROWS = 1000;
const PDF_BUDGET_MS = 3000; // spec §9.9: each PDF in 3 s
const PDF_REQUESTS = 5;
const POLL_MS = 2000;
const JOB_GIVE_UP_MS = 15 * 60_000; // stop waiting well after the budget so a stuck job does not hang the script
const REQUEST_TIMEOUT_MS = 60_000; // a cold Render instance can take this long to wake
const TOKEN_LIFETIME_MS = 12 * 60_000; // the access cookie lives 15 minutes; log in again before it ends

const MULTI = new Set(['firm', 'topic']);

function parseArgs(argv) {
  const args = { firm: [], topic: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Bad argument at position ${i + 1} (expected --name followed by a value)`);
    const name = key.slice(2);
    if (MULTI.has(name)) args[name].push(value);
    else args[name] = value;
  }
  // --password wins; without it the password is read from P6_PASSWORD, so it need not be typed on the command line.
  if (!args.password && process.env.P6_PASSWORD) args.password = process.env.P6_PASSWORD;
  for (const key of ['base', 'email', 'password', 'csv']) {
    if (!args[key]) throw new Error(key === 'password' ? '--password or the P6_PASSWORD environment variable is required' : `--${key} is required`);
  }
  for (const id of args.firm) {
    if (!/^[1-9]\d{0,9}$/.test(id)) throw new Error('--firm must be a firm id (1 to 10 digits)');
  }
  args.topic = args.topic.map((query) => query.replace(/^\?/, ''));
  args.base = args.base.replace(/\/+$/, '');
  return args;
}

// The access cookie the API sets. The refresh cookie is not kept; the script logs in again instead.
let accessCookie = '';
let loggedInAt = 0;

function readCookies(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq) === 'rr_at') accessCookie = pair.slice(eq + 1);
  }
}

async function login(args) {
  const response = await fetch(`${args.base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rejectradar-csrf': '1' },
    body: JSON.stringify({ email: args.email, password: args.password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Login failed: HTTP ${response.status}`);
  readCookies(response);
  if (!accessCookie) throw new Error('Login set no rr_at cookie');
  loggedInAt = Date.now();
}

async function authed(args, path, init = {}) {
  if (Date.now() - loggedInAt > TOKEN_LIFETIME_MS) await login(args);
  const headers = { cookie: `rr_at=${accessCookie}`, 'x-rejectradar-csrf': '1', ...init.headers };
  return fetch(`${args.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** The code and message of an error response, for a failure line. Never the request, so never a credential. */
async function describe(response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return `HTTP ${response.status} ${body.code ?? ''} ${body.message ?? ''}`.trim();
  } catch {
    return `HTTP ${response.status}`;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Data rows in a CSV: its non-blank lines less the header. A quoted newline would over-count; the API's own count decides the job. */
function countDataRows(text) {
  return Math.max(0, text.split(/\r?\n/).filter((line) => line.trim() !== '').length - 1);
}

/** Uploads the file and waits for the job to finish. Resolves to { rows, seconds, ok, note }. */
async function runBulkJob(args) {
  const buffer = await readFile(args.csv);
  const rows = countDataRows(buffer.toString('utf8'));
  console.log(`Bulk: uploading ${rows} rows (${(buffer.length / 1024).toFixed(0)} KB).`);

  const started = performance.now();
  const upload = await authed(args, `/v1/bulk-jobs?fileName=${encodeURIComponent('p6-measure.csv')}`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: buffer,
  });
  if (upload.status !== 202) return { rows, ok: false, note: `upload failed: ${await describe(upload)}` };
  const job = await upload.json();
  console.log(`Bulk: job ${job.id} accepted with ${job.total} rows.`);

  let last = job;
  let lastPrinted = -1;
  while (last.status !== 'finished') {
    if (performance.now() - started > JOB_GIVE_UP_MS) {
      return { rows: job.total, seconds: (performance.now() - started) / 1000, ok: false, note: `still ${last.status} at ${last.processed}/${last.total} after ${JOB_GIVE_UP_MS / 60_000} minutes` };
    }
    await sleep(POLL_MS);
    const poll = await authed(args, `/v1/bulk-jobs/${job.id}`);
    if (!poll.ok) return { rows: job.total, ok: false, note: `poll failed: ${await describe(poll)}` };
    last = await poll.json();
    const step = Math.floor(last.processed / 100);
    if (step !== lastPrinted) {
      lastPrinted = step;
      console.log(`  ${((performance.now() - started) / 1000).toFixed(0).padStart(4)} s  ${last.processed}/${last.total}`);
    }
  }
  const seconds = (performance.now() - started) / 1000;
  if (last.processed !== last.total) return { rows: job.total, seconds, ok: false, note: `finished with processed ${last.processed} of ${last.total}` };
  const budgeted = job.total <= JOB_BUDGET_ROWS;
  const over = budgeted && seconds > JOB_BUDGET_S;
  return {
    rows: job.total,
    seconds,
    ok: !over,
    judged: budgeted,
    note: over ? `OVER ${JOB_BUDGET_S} s` : budgeted ? 'ok' : `no budget applies above ${JOB_BUDGET_ROWS} rows`,
  };
}

/** Times `PDF_REQUESTS` requests for one PDF. Resolves to { name, samples, max, failures, ok }. */
async function timePdf(args, name, path) {
  const samples = [];
  let failures = 0;
  let problem = '';
  for (let i = 0; i < PDF_REQUESTS; i += 1) {
    const started = performance.now();
    const response = await authed(args, path);
    if (response.status !== 200) {
      problem = await describe(response);
      failures += 1;
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer()); // the body is part of the time
    const ms = performance.now() - started;
    const isPdf = response.headers.get('content-type')?.startsWith('application/pdf') && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-';
    if (!isPdf) {
      problem = 'the answer is not a PDF';
      failures += 1;
      continue;
    }
    samples.push({ ms, bytes: bytes.length });
  }
  const max = samples.length ? Math.max(...samples.map((s) => s.ms)) : undefined;
  return { name, samples, max, failures, problem, ok: failures === 0 && max !== undefined && max <= PDF_BUDGET_MS };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await login(args);

  // Render's free instances sleep; the first request wakes the API and is not part of any measurement.
  const health = await fetch(`${args.base}/v1/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await health.arrayBuffer();
  if (!health.ok) throw new Error(`GET /v1/health answered HTTP ${health.status}`);

  const job = await runBulkJob(args);
  console.log(job.seconds === undefined ? `Bulk: ${job.note}` : `Bulk: ${job.rows} rows finished in ${job.seconds.toFixed(1)} s (${job.note}).`);

  const pdfs = [];
  for (const id of args.firm) pdfs.push(await timePdf(args, `firm ${id}`, `/v1/firms/${id}/report.pdf`));
  for (const query of args.topic) pdfs.push(await timePdf(args, `topic ${query}`, `/v1/dashboards/topic/report.pdf?${query}`));
  if (pdfs.length === 0) console.log('No --firm or --topic given, so no PDF was timed.');

  const fmt = (value) => (value === undefined ? '-' : value.toFixed(0).padStart(7));
  if (pdfs.length > 0) {
    console.log(`\n${'pdf'.padEnd(48)} ${'ok'.padStart(3)} ${'max ms'.padStart(7)} ${'KB'.padStart(5)}  result`);
  }
  for (const pdf of pdfs) {
    const kb = pdf.samples.length ? (pdf.samples[0].bytes / 1024).toFixed(0) : '-';
    const note = pdf.failures > 0 ? `${pdf.failures} failed: ${pdf.problem}` : pdf.ok ? 'ok' : `OVER ${PDF_BUDGET_MS} ms`;
    console.log(`${pdf.name.padEnd(48)} ${String(pdf.samples.length).padStart(3)} ${fmt(pdf.max)} ${kb.padStart(5)}  ${note}`);
    if (pdf.samples.length) console.log(`  times: ${pdf.samples.map((s) => `${s.ms.toFixed(0)} ms`).join(', ')}`);
  }

  // The verdict names only what was judged: a job over 1,000 rows has no budget, and no --firm/--topic means no PDF was timed.
  const failed = !job.ok || pdfs.some((pdf) => !pdf.ok);
  const judged = [];
  judged.push(job.judged ? `bulk job of ${job.rows} rows within ${JOB_BUDGET_S} s` : null);
  judged.push(pdfs.length > 0 ? `${pdfs.length} PDF report(s) within ${PDF_BUDGET_MS} ms` : null);
  const passed = judged.filter(Boolean);
  const notJudged = [
    job.judged || !job.ok ? null : `the bulk job (over ${JOB_BUDGET_ROWS} rows, no budget)`,
    pdfs.length > 0 ? null : 'the PDFs (no --firm or --topic given)',
  ].filter(Boolean);
  let line;
  if (failed) line = `FAIL: the bulk job is over ${JOB_BUDGET_S} s or failed, or a PDF is over ${PDF_BUDGET_MS} ms or failed.`;
  else if (passed.length === 0) line = `NOTHING JUDGED: ${notJudged.join('; ')}.`;
  else line = `OK: ${passed.join(' and ')}${notJudged.length ? `; not judged: ${notJudged.join('; ')}` : ''}.`;
  console.log(`
${line}`);
  console.log('V11 memory: read the pdf_rendered lines (rssMb) in the API logs; they should stay under 400.');
  process.exitCode = failed || passed.length === 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  if (error.cause) console.error('Cause:', error.cause);
  process.exitCode = 1;
});
