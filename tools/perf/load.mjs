#!/usr/bin/env node
// p95 load script for notice search, dashboards, the watchlist and firm search (roadmap 5.10).
// Usage: node tools/perf/load.mjs --base <url> --email <e> --password <p> [--requests 200] [--concurrency 4] [--firm-requests 50] [--watchlist-items 250]
// No dependencies: Node 20+ `fetch`. Exits 1 when any scenario's p95 is over the budget.

const BUDGET_MS = 800;
const FIRM_PACE_MS = 2200; // firm search is limited to 30 requests a minute per user; 2.2 s keeps a minute's window at 28 requests, with room for the warm-up
const FIRM_WINDOW_MS = 61_000; // the rate-limit window is 60 s; wait a little longer than that for it to empty
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_LIFETIME_MS = 12 * 60_000; // the access cookie lives 15 minutes; log in again before it ends

const SCENARIOS = [
  { name: 'notices: no filter', path: '/v1/notices' },
  { name: 'notices: origin=PK&commodity=100', path: '/v1/notices?origin=PK&commodity=100' },
  { name: 'notices: q=rice', path: '/v1/notices?q=rice' },
  { name: 'dashboard: origin=PK', path: '/v1/dashboards/topic?origin=PK' },
  { name: 'dashboard: origin=IN&commodity=200&destination=EU,UK', path: '/v1/dashboards/topic?origin=IN&commodity=200&destination=EU,UK' },
  { name: 'watchlist: GET /v1/watchlist', path: '/v1/watchlist', prepare: ensureWatchlist },
  { name: 'firm search: name=rice mills&country=PK', path: '/v1/firms/search?name=rice%20mills&country=PK', paced: true },
  { name: 'firm search: name=al rahman', path: '/v1/firms/search?name=al%20rahman', paced: true },
];

function parseArgs(argv) {
  const args = { requests: 200, concurrency: 4, firmRequests: 50, watchlistItems: 250 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Bad argument near "${key ?? ''}"`);
    args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const key of ['requests', 'concurrency', 'firmRequests', 'watchlistItems']) {
    args[key] = Number(args[key]);
    if (!Number.isInteger(args[key]) || args[key] < 1) throw new Error(`--${key} must be a positive integer`);
  }
  for (const key of ['base', 'email', 'password']) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  args.base = args.base.replace(/\/+$/, '');
  return args;
}

// The cookie jar: the access cookie the API sets. The refresh cookie is not kept; the script logs in again instead.
let accessCookie = '';
let loggedInAt = 0;

function readCookies(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name === 'rr_at') accessCookie = value;
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

async function ensureSession(args) {
  if (Date.now() - loggedInAt > TOKEN_LIFETIME_MS) await login(args);
}

const isFirmSearch = (path) => path.startsWith('/v1/firms/search');
let lastFirmRequestAt = 0; // when the last firm search went out, for the 30-a-minute window

/** One timed GET. Resolves to { ms, status }. */
async function timed(args, path) {
  await ensureSession(args);
  if (isFirmSearch(path)) lastFirmRequestAt = Date.now();
  const started = performance.now();
  const response = await fetch(`${args.base}${path}`, { headers: { cookie: `rr_at=${accessCookie}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await response.arrayBuffer(); // the body is part of the response time
  return { ms: performance.now() - started, status: response.status };
}

/** Origin countries and destinations for the watchlist's topic items: every pairing is a distinct topic. */
const WATCHLIST_ORIGINS = [
  'PK', 'IN', 'CN', 'VN', 'TH', 'ID', 'BD', 'LK', 'TR', 'EG', 'MA', 'ES', 'IT', 'FR', 'DE', 'NL', 'PL', 'BR', 'AR', 'MX',
  'EC', 'PE', 'CL', 'ZA', 'KE', 'NG', 'GH', 'IR', 'AE', 'SA', 'JP', 'KR', 'PH', 'MY', 'SG', 'NZ', 'GR', 'PT', 'BE', 'HU',
  'RO', 'BG', 'UA', 'RU', 'CA', 'CO', 'CR', 'GT', 'UY', 'MM', 'NP', 'KH', 'TN', 'DZ', 'JO', 'LB', 'SN', 'UG', 'TZ', 'ET',
];
const WATCHLIST_DESTINATIONS = [undefined, 'US', 'EU', 'UK', 'AU'];

async function authed(args, path, init = {}) {
  await ensureSession(args);
  const headers = { cookie: `rr_at=${accessCookie}`, ...init.headers };
  return fetch(`${args.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * Brings the account's watchlist up to `--watchlist-items` topic items (or to its plan's limit), through
 * POST /v1/watchlist, before the timed requests. Items it finds already there count; it never removes any.
 */
async function ensureWatchlist(args) {
  const listing = await authed(args, '/v1/watchlist');
  if (!listing.ok) throw new Error(`GET /v1/watchlist answered HTTP ${listing.status}`);
  const { used, limit } = await listing.json();
  const target = Math.min(args.watchlistItems, limit);
  if (target < args.watchlistItems) console.warn(`Note: the plan allows ${limit} watchlist items, fewer than the ${args.watchlistItems} asked for.`);
  let have = used;
  let added = 0;
  for (const destination of WATCHLIST_DESTINATIONS) {
    for (const originCountry of WATCHLIST_ORIGINS) {
      if (have >= target) {
        console.log(`Watchlist: ${have} items (${added} added).`);
        return;
      }
      const response = await authed(args, '/v1/watchlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rejectradar-csrf': '1' },
        body: JSON.stringify({ kind: 'topic', originCountry, ...(destination ? { destination } : {}) }),
      });
      await response.arrayBuffer();
      if (response.status === 201 || response.status === 200) {
        have += 1;
        added += 1;
      } else if (response.status !== 409) {
        // 409: this topic is on the list already, so try the next one.
        throw new Error(`POST /v1/watchlist answered HTTP ${response.status} with ${have} items on the list`);
      }
    }
  }
  console.log(`Watchlist: ${have} items (${added} added); the script has no more distinct topics to add.`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(sorted, p) {
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function runScenario(args, scenario) {
  const total = scenario.paced ? args.firmRequests : args.requests;
  const samples = [];
  let failures = 0;
  let next = 0;
  const worker = async () => {
    while (next < total) {
      next += 1;
      const started = performance.now();
      const result = await timed(args, scenario.path);
      if (result.status === 200) samples.push(result.ms);
      else failures += 1;
      if (scenario.paced) await sleep(Math.max(0, FIRM_PACE_MS - (performance.now() - started)));
    }
  };
  await Promise.all(Array.from({ length: scenario.paced ? 1 : args.concurrency }, worker));
  samples.sort((a, b) => a - b);
  return { name: scenario.name, count: samples.length, failures, p50: percentile(samples, 50), p95: percentile(samples, 95), max: samples[samples.length - 1] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await login(args);

  const results = [];
  let firstPaced = true;
  for (const scenario of SCENARIOS) {
    // One warm-up per scenario, just before it, outside the budget (the first request after Neon sleeps is not measured).
    // A firm scenario's warm-up counts against the same 30-a-minute window as its timed requests, so it is not done earlier.
    if (scenario.paced && firstPaced) {
      firstPaced = false;
      const sinceFirm = Date.now() - lastFirmRequestAt;
      if (lastFirmRequestAt > 0 && sinceFirm < FIRM_WINDOW_MS) await sleep(FIRM_WINDOW_MS - sinceFirm);
    }
    if (scenario.prepare) await scenario.prepare(args);
    let warm = await timed(args, scenario.path);
    if (warm.status === 429 && scenario.paced) {
      // A run just before this one may still hold the window; wait it out once.
      await sleep(FIRM_WINDOW_MS);
      warm = await timed(args, scenario.path);
    }
    if (warm.status !== 200) throw new Error(`Warm-up for "${scenario.name}" answered HTTP ${warm.status}`);
    if (scenario.paced) await sleep(FIRM_PACE_MS);
    results.push(await runScenario(args, scenario));
    if (scenario.paced) await sleep(FIRM_PACE_MS);
  }

  const fmt = (value) => (value === undefined ? '-' : value.toFixed(0).padStart(6));
  console.log(`\n${'scenario'.padEnd(56)} ${'n'.padStart(4)} ${'p50 ms'.padStart(7)} ${'p95 ms'.padStart(7)} ${'max ms'.padStart(7)}  result`);
  let failed = false;
  for (const r of results) {
    const over = r.failures > 0 || r.count === 0 || r.p95 > BUDGET_MS;
    failed ||= over;
    const note = r.failures > 0 ? `${r.failures} non-200 responses` : over ? `OVER ${BUDGET_MS} ms` : 'ok';
    console.log(`${r.name.padEnd(56)} ${String(r.count).padStart(4)} ${fmt(r.p50)}  ${fmt(r.p95)}  ${fmt(r.max)}  ${note}`);
  }
  console.log(failed ? `\nFAIL: a scenario is over the ${BUDGET_MS} ms p95 budget or failed.` : `\nOK: every p95 is within ${BUDGET_MS} ms.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  if (error.cause) console.error('Cause:', error.cause);
  process.exitCode = 1;
});
