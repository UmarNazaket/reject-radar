import { createHash } from 'node:crypto';
import type { FetchOptions, Fetcher, FetchResult } from './http';

/** Test double for a {@link FetchResult}; only for use in specs. */
export function fetchResult(body: string | Buffer, init: { status?: number; contentType?: string; url?: string } = {}): FetchResult {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    url: init.url ?? 'https://example.test/',
    status: init.status ?? 200,
    contentType: init.contentType ?? 'application/octet-stream',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    text: () => bytes.toString('utf8'),
    json: <T = unknown>() => JSON.parse(bytes.toString('utf8')) as T,
  };
}

export interface RecordedCall {
  url: string;
  options: FetchOptions | undefined;
}

/** A {@link Fetcher} that answers every call with `respond` and records the calls; only for use in specs. */
export function fakeFetcher(respond: (url: string, options?: FetchOptions) => FetchResult | Promise<FetchResult>): {
  fetcher: Fetcher;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetcher: Fetcher = async (url, options) => {
    calls.push({ url, options });
    return respond(url, options);
  };
  return { fetcher, calls };
}
