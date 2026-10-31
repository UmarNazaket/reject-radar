#!/usr/bin/env node
// Read-only smoke check of a deployed RejectRadar (P11): API readiness, the plan list, a sign-in, a notice search and a
// firm search, and optionally the web app. Usage, with SMOKE_EMAIL and SMOKE_PASSWORD set to a smoke account:
//   node tools/smoke/check.mjs --base <api origin> [--web <web origin>] [--firm <name>]
// No dependencies: Node 20+ `fetch`. Exits 1 when any check fails.

const REQUEST_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const args = { firm: 'rice mills' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Bad argument near "${key ?? ''}"`);
    args[key.slice(2)] = value;
  }
  if (!args.base) throw new Error('--base is required');
  args.base = args.base.replace(/\/+$/, '');
  args.web = args.web?.replace(/\/+$/, '');
  args.email = process.env.SMOKE_EMAIL;
  args.password = process.env.SMOKE_PASSWORD;
  if (!args.email || !args.password)
    throw new Error('Set SMOKE_EMAIL and SMOKE_PASSWORD');
  return args;
}

const cookies = new Map();

async function request(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'x-rejectradar-csrf': '1',
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return response;
}

/** A GET or POST that must answer `status`; resolves to the parsed JSON body (or the text, for HTML). */
async function expectStatus(url, status, init) {
  const response = await request(url, init);
  if (response.status !== status)
    throw new Error(`HTTP ${response.status}, expected ${status}`);
  return (response.headers.get('content-type') ?? '').includes('json')
    ? response.json()
    : response.text();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checks(args) {
  const api = (path) => `${args.base}${path}`;
  const list = [
    [
      'API ready',
      async () =>
        assert(
          (await expectStatus(api('/v1/health/ready'), 200)).status === 'ready',
          'not ready',
        ),
    ],
    [
      'Plan list with prices',
      async () => {
        const { plans } = await expectStatus(api('/v1/billing/plans'), 200);
        for (const id of ['pro', 'business'])
          assert(plans.find((p) => p.id === id)?.prices, `${id} has no prices`);
      },
    ],
    [
      'Sign in',
      async () => {
        const body = JSON.stringify({
          email: args.email,
          password: args.password,
        });
        await expectStatus(api('/v1/auth/login'), 200, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        assert(cookies.get('rr_at'), 'no rr_at cookie');
      },
    ],
    [
      'Notice search',
      async () =>
        assert(
          (await expectStatus(api('/v1/notices'), 200)).items.length > 0,
          'no notices',
        ),
    ],
    [
      `Firm search "${args.firm}"`,
      async () =>
        assert(
          (
            await expectStatus(
              api(`/v1/firms/search?name=${encodeURIComponent(args.firm)}`),
              200,
            )
          ).results.length > 0,
          'no firms',
        ),
    ],
    // Ends the smoke session, so each run leaves no live refresh token behind.
    [
      'Sign out',
      () => expectStatus(api('/v1/auth/logout'), 204, { method: 'POST' }),
    ],
  ];
  if (args.web) {
    list.push([
      'Web app built for this API',
      async () => {
        const html = await expectStatus(`${args.web}/`, 200);
        const main = html.match(/src="(main-[\w-]+\.js)"/)?.[1];
        assert(
          html.includes('<app-root') && main,
          'not the RejectRadar web app',
        );
        assert(
          (await expectStatus(`${args.web}/${main}`, 200)).includes(args.base),
          `the build does not call ${args.base}`,
        );
      },
    ]);
  }
  return list;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let failed = 0;
  for (const [name, run] of checks(args)) {
    const started = performance.now();
    try {
      await run();
      console.log(
        `ok    ${name} (${Math.round(performance.now() - started)} ms)`,
      );
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}: ${error.cause?.message ?? error.message}`);
    }
  }
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
