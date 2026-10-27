import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes as 43 base64url characters; the form of every email link and refresh token. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as this hash, so a database read never yields a usable token. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
