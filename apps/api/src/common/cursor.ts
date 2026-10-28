import { HttpStatus } from '@nestjs/common';
import { AppError } from './errors';

const CURSOR = /^(\d{4}-\d{2}-\d{2})\|(\d{1,18})$/;

/** An opaque page cursor (P5-D5): base64url of `<date>|<id>`, the position of the last row on the page. */
export function encodeCursor(date: string, id: number | string): string {
  return Buffer.from(`${date}|${id}`, 'utf8').toString('base64url');
}

/** The date and id a cursor holds; anything else, including a date that does not exist, is `400 BAD_REQUEST`. */
export function decodeCursor(cursor: string): { date: string; id: string } {
  const match = CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (match && !Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) && new Date(`${match[1]}T00:00:00Z`).toISOString().startsWith(match[1])) {
    return { date: match[1], id: match[2] };
  }
  throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'The page cursor is not valid.');
}

const TIME_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * A page cursor for rows ordered by a timestamp, then a uuid (the alerts list). `timestamp` is the row's UTC time to the
 * microsecond (`YYYY-MM-DDTHH:MM:SS.ffffffZ`, as Postgres prints it): a JS `Date` keeps only milliseconds, which would
 * skip or repeat rows that differ below that.
 */
export function encodeTimeCursor(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}|${id}`, 'utf8').toString('base64url');
}

/** The timestamp and id a time cursor holds; anything else is `400 BAD_REQUEST`. */
export function decodeTimeCursor(cursor: string): { timestamp: string; id: string } {
  const match = TIME_CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  // `toISOString` rolls an impossible date (February 30th) over to the next month, which no longer matches the text.
  const real = match ? new Date(`${match[1].slice(0, 19)}Z`) : null;
  if (match && real && !Number.isNaN(real.getTime()) && real.toISOString().slice(0, 19) === match[1].slice(0, 19)) {
    return { timestamp: match[1], id: match[2] };
  }
  throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'The page cursor is not valid.');
}
