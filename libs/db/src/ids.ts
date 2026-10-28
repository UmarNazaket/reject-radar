import { randomBytes } from 'node:crypto';

/**
 * UUID v7 (RFC 9562): a 48-bit big-endian millisecond timestamp, then random bits, so ids sort by creation time
 * and index well. Ids made in the same millisecond are distinct but not ordered among themselves.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10xx
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
