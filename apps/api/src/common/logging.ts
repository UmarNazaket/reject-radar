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

/** How deep a cause chain is followed; deeper causes are cut off (this also ends a cycle). */
const MAX_CAUSE_DEPTH = 5;
/** Drizzle's `DrizzleQueryError` message is `Failed query: <sql>\nparams: <values>`; everything from here on is values. */
const PARAMS_MARKER = '\nparams:';

type ErrorLike = Error & { code?: unknown; constraint?: unknown; cause?: unknown; errors?: unknown };

function isErrorLike(value: unknown): value is ErrorLike {
  return value instanceof Error || (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string');
}

/**
 * The message without Drizzle's parameter list. The SQL before it stays: it uses `$1` placeholders, so it carries no
 * values, and it is what tells the reader which query failed.
 */
function withoutParams(message: string): string {
  const at = message.indexOf(PARAMS_MARKER);
  return at === -1 ? message : message.slice(0, at);
}

/** The stack repeats the message in its first lines, so the parameter list is cut there as well. */
function stackWithoutParams(stack: string, message: string, safeMessage: string): string {
  let out = message !== safeMessage && stack.includes(message) ? stack.replace(message, () => safeMessage) : stack;
  // Fallback when the header does not match the message verbatim: drop the parameter lines up to the first frame.
  const at = out.indexOf(PARAMS_MARKER);
  if (at !== -1) {
    const frame = out.slice(at + 1).search(/\n\s+at /);
    out = out.slice(0, at) + (frame === -1 ? '' : out.slice(at + 1 + frame));
  }
  return out;
}

function serializeError(err: ErrorLike, depth: number, seen: Set<unknown>): Record<string, unknown> {
  seen.add(err);
  const message = withoutParams(err.message);
  const out: Record<string, unknown> = {
    type: typeof err.constructor === 'function' ? err.constructor.name : err.name,
    name: err.name,
    message,
  };
  if (typeof err.stack === 'string') out['stack'] = stackWithoutParams(err.stack, err.message, message);
  if (typeof err.code === 'string' || typeof err.code === 'number') out['code'] = err.code;
  if (typeof err.constraint === 'string') out['constraint'] = err.constraint;
  if (depth < MAX_CAUSE_DEPTH) {
    if (isErrorLike(err.cause) && !seen.has(err.cause)) out['cause'] = serializeError(err.cause, depth + 1, seen);
    if (Array.isArray(err.errors)) {
      out['errors'] = err.errors.filter((inner) => isErrorLike(inner) && !seen.has(inner)).map((inner) => serializeError(inner, depth + 1, seen));
    }
  }
  return out;
}

/**
 * pino `err` serializer. It keeps only the type, name, message, stack, `code` and `constraint` of an error and of each
 * error in its cause chain (and an AggregateError's `errors`). Everything else is dropped: Drizzle's `query` and
 * `params` (sign-up and reset params hold the new argon2 hash and the email), node-postgres's `detail` (which repeats
 * the conflicting value), and any other enumerable property. The parameter list is also cut out of Drizzle's message
 * and stack. A value that is not an error passes through.
 */
export function errSerializer(input: unknown): unknown {
  // pino-http hands a custom serializer pino's standard output, which keeps the original error on `raw`.
  const raw = typeof input === 'object' && input !== null && 'raw' in input ? (input as { raw: unknown }).raw : input;
  return isErrorLike(raw) ? serializeError(raw, 0, new Set()) : input;
}
