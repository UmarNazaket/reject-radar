import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a signed timestamp may be from now, in seconds (P7-D1). */
export const PADDLE_SIGNATURE_TOLERANCE_SEC = 30;

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const DIGITS = /^\d{1,12}$/;

const digest = (rawBody: Buffer, secret: string, ts: string): Buffer => createHmac('sha256', secret).update(`${ts}:`).update(rawBody).digest();

/** The `Paddle-Signature` header value for a body: `ts=<unix>;h1=<hex>`. Used by specs and the manual tools. */
export function signPaddlePayload(rawBody: Buffer, secret: string, tsSec: number): string {
  return `ts=${tsSec};h1=${digest(rawBody, secret, String(tsSec)).toString('hex')}`;
}

/**
 * Checks a `Paddle-Signature` header (`ts=<unix>;h1=<hex>[;h1=<hex>…]`) against the raw request body (P7-D1).
 * Paddle sends two `h1` values while a secret is being rotated, so any one may match. Never throws.
 */
export function verifyPaddleSignature(rawBody: Buffer, header: string | undefined, secret: string, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  let ts: string | undefined;
  const candidates: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'h1') candidates.push(value);
  }
  if (ts === undefined || !DIGITS.test(ts) || candidates.length === 0) return false;
  if (Math.abs(nowSec - Number(ts)) > PADDLE_SIGNATURE_TOLERANCE_SEC) return false;

  const expected = digest(rawBody, secret, ts);
  // Every candidate is compared, so the time taken does not reveal which one matched.
  let ok = false;
  for (const candidate of candidates) {
    if (!HEX_SHA256.test(candidate)) continue;
    if (timingSafeEqual(Buffer.from(candidate, 'hex'), expected)) ok = true;
  }
  return ok;
}
