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
