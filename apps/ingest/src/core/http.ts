import { createHash } from 'node:crypto';

/** Every host a sync may talk to (spec §6.3 rule 5, §12). Anything else, including redirect targets, is refused. */
export const SOURCE_HOSTS: readonly string[] = [
  'api-datadashboard.fda.gov',
  'datadashboard.fda.gov',
  'www.accessdata.fda.gov',
  'webgate.ec.europa.eu',
  'ec.europa.eu',
  'www.data.gov.uk',
  'data.gov.uk',
  'ckan.publishing.service.gov.uk',
  'fsaopendata.blob.core.windows.net',
  'data.gov.au',
];

/** Minimum gap between two requests to the same host. accessdata.fda.gov's robots.txt says `Hit-rate: 30`. */
export const HOST_MIN_INTERVAL_MS: Readonly<Record<string, number>> = { 'www.accessdata.fda.gov': 30_000 };
const DEFAULT_MIN_INTERVAL_MS = 1_000;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 3;
const BACKOFF_MS: readonly number[] = [2_000, 8_000, 30_000];
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_REDIRECTS = 5;

export type Expect = 'json' | 'csv' | 'html' | 'xml' | 'any';

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** What the caller will parse; HTML where data was expected is an error. Default `any`. */
  expect?: Expect;
  timeoutMs?: number;
  retries?: number;
  /**
   * Return a 4xx response (other than 429) to the caller instead of throwing.
   * For APIs such as the FDA Data Dashboard whose error details live in the response body.
   */
  acceptClientErrors?: boolean;
}

export interface FetchResult {
  /** The final URL, after redirects. */
  url: string;
  status: number;
  contentType: string;
  bytes: Buffer;
  sha256: string;
  text(): string;
  json<T = unknown>(): T;
}

export type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchResult>;

export class SourceFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

export interface FetcherDeps {
  contact: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A timeout: the only SourceFetchError raised mid-request that is worth retrying. */
class TransientFetchError extends SourceFetchError {}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createFetcher(deps: FetcherDeps): Fetcher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const userAgent = `RejectRadar data sync (${deps.contact})`;
  /** Earliest time each host has been reserved until; set before sleeping so concurrent callers queue up. */
  const nextSlot = new Map<string, number>();

  async function pace(host: string, minDelay: number): Promise<void> {
    const current = now();
    const reserved = nextSlot.get(host);
    const interval = HOST_MIN_INTERVAL_MS[host] ?? DEFAULT_MIN_INTERVAL_MS;
    const spacing = reserved === undefined ? 0 : reserved + interval - current;
    const delay = Math.max(spacing, minDelay, 0);
    nextSlot.set(host, current + delay);
    if (delay > 0) await sleep(delay);
  }

  async function requestOnce(
    startUrl: string,
    options: FetchOptions,
    minDelay: number,
  ): Promise<{ response: Response; bytes: Buffer; url: string }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let url = startUrl;
    let method = options.method ?? 'GET';
    let body = options.body;
    let headers: Record<string, string> = { ...options.headers };
    let delay = minDelay;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const host = assertAllowed(url);
      await pace(host, delay);
      delay = 0;
      const signal = AbortSignal.timeout(timeoutMs);
      const init: RequestInit = { method, headers: { ...headers, 'User-Agent': userAgent }, redirect: 'manual', signal };
      if (body !== undefined) init.body = body;

      const { response, bytes } = await raceTimeout(signal, timeoutMs, url, async () => {
        const res = await fetchImpl(url, init);
        if (REDIRECT_STATUSES.has(res.status)) {
          await res.body?.cancel().catch(() => undefined);
          return { response: res, bytes: Buffer.alloc(0) };
        }
        return { response: res, bytes: Buffer.from(await res.arrayBuffer()) };
      });

      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || !location) return { response, bytes, url };
      if (hop === MAX_REDIRECTS) throw new SourceFetchError(`Too many redirects (more than ${MAX_REDIRECTS}) from ${startUrl}`, response.status, startUrl);

      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new SourceFetchError(`Redirect to an invalid location "${location}" from ${url}`, response.status, url);
      }
      if (next.host !== new URL(url).host) headers = {};
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !/^content-/i.test(name)));
      }
      url = next.toString();
    }
    throw new SourceFetchError(`Too many redirects from ${startUrl}`, null, startUrl);
  }

  return async (url, options = {}) => {
    const retries = options.retries ?? DEFAULT_RETRIES;
    let lastError: SourceFetchError | null = null;
    let minDelay = 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let result: { response: Response; bytes: Buffer; url: string };
      try {
        result = await requestOnce(url, options, minDelay);
      } catch (error) {
        if (error instanceof SourceFetchError && !(error instanceof TransientFetchError)) throw error;
        lastError = toFetchError(error, url);
        minDelay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        continue;
      }

      const { response, bytes } = result;
      const code = response.status;
      if (code === 429 || code >= 500) {
        lastError = new SourceFetchError(`HTTP ${code} for ${result.url}`, code, result.url);
        minDelay = retryDelay(response.headers.get('retry-after'), attempt);
        continue;
      }
      if (code >= 400 && !(options.acceptClientErrors && code !== 429)) {
        throw new SourceFetchError(`HTTP ${code} for ${result.url}`, code, result.url);
      }
      if (code >= 300 && code < 400) {
        throw new SourceFetchError(`Unexpected HTTP ${code} for ${result.url}`, code, result.url);
      }
      return buildResult(result.url, code, response.headers.get('content-type') ?? '', bytes, options.expect ?? 'any');
    }

    const attempts = retries + 1;
    throw new SourceFetchError(`${lastError?.message ?? `Failed to fetch ${url}`} (gave up after ${attempts} attempt${attempts === 1 ? '' : 's'})`, lastError?.status ?? null, lastError?.url ?? url);
  };
}

function assertAllowed(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourceFetchError(`Not a valid URL: ${url}`, null, url);
  }
  if (parsed.protocol !== 'https:') throw new SourceFetchError(`Only https:// URLs may be fetched: ${url}`, null, url);
  if (!SOURCE_HOSTS.includes(parsed.hostname)) {
    throw new SourceFetchError(`Host ${parsed.hostname} is not in the source allow-list (${url})`, null, url);
  }
  return parsed.hostname;
}

/** Network failures and timeouts are worth retrying; allow-list and redirect failures are not. */
function toFetchError(error: unknown, url: string): SourceFetchError {
  if (error instanceof SourceFetchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SourceFetchError(`Request to ${url} failed: ${message}`, null, url);
}

async function raceTimeout<T>(signal: AbortSignal, timeoutMs: number, url: string, work: () => Promise<T>): Promise<T> {
  let onAbort: (() => void) | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    onAbort = () => reject(new TransientFetchError(`Request to ${url} timed out after ${timeoutMs} ms`, null, url));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(), timedOut]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    timedOut.catch(() => undefined);
  }
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

const HTML_START = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

function buildResult(url: string, status: number, contentType: string, bytes: Buffer, expect: Expect): FetchResult {
  const text = () => bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (expect === 'json' || expect === 'csv' || expect === 'xml') {
    const isHtml = /\bhtml\b/i.test(contentType) || HTML_START.test(text().slice(0, 512));
    if (isHtml) {
      throw new SourceFetchError(`expected ${expect} but ${url} returned HTML (content-type "${contentType}")`, status, url);
    }
  }
  return {
    url,
    status,
    contentType,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    text,
    json: <T = unknown>() => JSON.parse(text()) as T,
  };
}
