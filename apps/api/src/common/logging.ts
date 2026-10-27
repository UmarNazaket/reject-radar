import type { IncomingMessage, ServerResponse } from 'node:http';

/** The only request headers that reach the logs. Cookies, Authorization and anything else are never logged. */
export const LOGGED_REQUEST_HEADERS = ['user-agent', 'content-type', 'content-length', 'origin', 'x-request-id'] as const;
/** The only response headers that reach the logs; `set-cookie` is never one of them. */
export const LOGGED_RESPONSE_HEADERS = ['content-type', 'content-length'] as const;

type Headers = Record<string, string | string[] | number | undefined>;

function pick(headers: Headers, names: readonly string[]): Record<string, string | string[] | number> {
  const picked: Record<string, string | string[] | number> = {};
  for (const name of names) {
    const value = headers[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

/** What express adds to a request on top of Node's `IncomingMessage`, plus the id pino-http assigns. */
export type LoggableRequest = IncomingMessage & { id?: unknown; ip?: string; originalUrl?: string };

/** The URL path only: tokens and other secrets travel in query strings, so the query never reaches the logs. */
function pathOf(url: string | undefined): string {
  if (!url) return '';
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** pino-http hands a custom serializer pino's own serialised form, which keeps the original object on `raw`. */
function rawOf<T extends object>(value: T | { raw: T }): T {
  return 'raw' in value ? value.raw : value;
}

export function reqSerializer(input: LoggableRequest | { raw: LoggableRequest }) {
  const req = rawOf(input);
  return {
    id: req.id,
    method: req.method,
    url: pathOf(req.originalUrl ?? req.url),
    ip: req.ip ?? req.socket?.remoteAddress,
    headers: pick(req.headers, LOGGED_REQUEST_HEADERS),
  };
}

export function resSerializer(input: ServerResponse | { raw: ServerResponse }) {
  const res = rawOf(input);
  return {
    statusCode: res.statusCode,
    headers: pick(res.getHeaders(), LOGGED_RESPONSE_HEADERS),
  };
}
