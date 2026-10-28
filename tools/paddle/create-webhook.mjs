#!/usr/bin/env node
// Creates the Paddle notification destination that points at POST /v1/webhooks/paddle (spec §10.2, P7).
// Usage: node tools/paddle/create-webhook.mjs --url <https webhook url> [--description <text>] [--show-secret] [--production]
// No dependencies: Node 20+ `fetch`. Reads PADDLE_API_KEY from .env (or the environment). Never prints the API key.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The five notifications the API acts on; keep in step with PADDLE_HANDLED_EVENTS in apps/api/src/billing/paddle/events.ts.
const EVENTS = [
  'subscription.created',
  'subscription.updated',
  'subscription.canceled',
  'subscription.past_due',
  'transaction.completed',
];
const SANDBOX_KEY_PREFIX = 'pdl_sdbx_apikey_';
const LIVE_KEY_PREFIX = 'pdl_live_apikey_';
const REQUEST_TIMEOUT_MS = 30_000;

const USAGE = `Usage: node tools/paddle/create-webhook.mjs --url <https webhook url> [--description <text>] [--show-secret] [--production]

Creates a Paddle notification destination for the five events the API handles.
  --url           the public HTTPS URL of POST /v1/webhooks/paddle (required)
  --description   the destination's name in the Paddle dashboard (default "RejectRadar webhook")
  --show-secret   also print the endpoint secret (otherwise only where to find it)
  --production    allow a live API key (pdl_live_apikey_...); without it only a sandbox key is accepted
  --help          this text`;

function parseArgs(argv) {
  const args = {
    description: 'RejectRadar webhook',
    showSecret: false,
    production: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--help' || key === '-h') args.help = true;
    else if (key === '--show-secret') args.showSecret = true;
    else if (key === '--production') args.production = true;
    else if (key === '--url' || key === '--description') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`${key} needs a value`);
      args[key.slice(2)] = value;
      i += 1;
    } else throw new Error(`Unknown argument "${key}"`);
  }
  if (args.help) return args;
  if (!args.url) throw new Error('--url is required');
  let parsed;
  try {
    parsed = new URL(args.url);
  } catch {
    throw new Error('--url must be a full URL');
  }
  if (parsed.protocol !== 'https:')
    throw new Error('--url must be an https:// URL');
  if (!args.description.trim())
    throw new Error('--description must not be empty');
  return args;
}

/** Reads KEY=value lines from the repository's .env; a real environment variable wins. */
function readEnvFile() {
  const values = {};
  try {
    const text = readFileSync(
      fileURLToPath(new URL('../../.env', import.meta.url)),
      'utf8',
    );
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch {
    // no .env: the environment may still hold the key
  }
  return values;
}

function pickApiKey(args) {
  const key = process.env.PADDLE_API_KEY ?? readEnvFile().PADDLE_API_KEY;
  if (!key)
    throw new Error('PADDLE_API_KEY is not set in .env or the environment');
  if (key.startsWith(SANDBOX_KEY_PREFIX))
    return {
      key,
      base: 'https://sandbox-api.paddle.com',
      environment: 'sandbox',
    };
  if (key.startsWith(LIVE_KEY_PREFIX)) {
    if (!args.production)
      throw new Error(
        'PADDLE_API_KEY is a live key; this tool only uses a sandbox key unless you pass --production',
      );
    return { key, base: 'https://api.paddle.com', environment: 'production' };
  }
  throw new Error(
    `PADDLE_API_KEY must start with ${SANDBOX_KEY_PREFIX} or ${LIVE_KEY_PREFIX}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const { key, base, environment } = pickApiKey(args);
  const response = await fetch(`${base}/notification-settings`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      description: args.description,
      destination: args.url,
      type: 'url',
      subscribed_events: EVENTS,
      api_version: 1,
      include_sensitive_fields: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error;
    throw new Error(
      `Paddle answered HTTP ${response.status}${error ? `: ${error.code} - ${error.detail}` : ''}`,
    );
  }
  const destination = body?.data;
  if (!destination?.id)
    throw new Error('Paddle answered without a destination id');

  console.log(
    `Created ${environment} notification destination ${destination.id}`,
  );
  console.log(`  url:    ${destination.destination}`);
  console.log(`  events: ${EVENTS.join(', ')}`);
  const dashboardHint =
    'The endpoint secret is in the Paddle dashboard: Developer tools > Notifications > the destination > endpoint secret key.';
  if (args.showSecret && destination.endpoint_secret_key) {
    console.log(`  endpoint secret: ${destination.endpoint_secret_key}`);
    console.log(
      'Put it in PADDLE_WEBHOOK_SECRET (Render staging and the local .env). Keep it out of chat and logs.',
    );
  } else if (args.showSecret) {
    console.log('Paddle did not return the endpoint secret in its answer.');
    console.log(dashboardHint);
  } else {
    console.log(dashboardHint);
    console.log(
      'Copy it into PADDLE_WEBHOOK_SECRET. Do not rerun this tool to see it: a second run creates a second destination with a different secret. If you need to, delete this destination in the dashboard and rerun with --show-secret.',
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('Run with --help for usage.');
  process.exit(1);
});
