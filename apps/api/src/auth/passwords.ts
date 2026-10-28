import { HttpStatus } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { AppError } from '../common/errors';
import { COMMON_PASSWORDS } from './common-passwords';

/** argon2id at the OWASP minimum: 19 MiB, 2 passes, 1 lane (spec 12). */
const HASH_OPTIONS = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, HASH_OPTIONS);
}

/** True only for a matching password; a malformed stored hash counts as a mismatch rather than an error. */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

/** Checked ignoring case against the 10-or-more-character entries of the top-10k list (shorter ones fail the length rule). */
export function isCommonPassword(plain: string): boolean {
  return COMMON_PASSWORDS.has(plain.toLowerCase());
}

/** The refusal for a password on the common list; sign-up, reset and invite acceptance all answer with it. */
export const commonPasswordError = (): AppError =>
  new AppError(HttpStatus.BAD_REQUEST, 'COMMON_PASSWORD', 'This password is too common. Choose a different one.');

/**
 * A fixed argon2id hash (same parameters) of a random value that was thrown away. Login verifies against it when the
 * email is unknown, so a miss costs the same time as a wrong password.
 */
export const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,p=1,t=2$y9zzCqniJrpby8jv19bWZQ$5LyhP9+9sVzb4nAZ86Y+sKFNYp1a9vsiRbE5DPZfOjY';
