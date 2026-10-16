import { MATCH_CONFIG } from './config';
import { isUsableName } from './normalize-name';

/** A name is distinctive when its rarest token appears in fewer than `maxFreq` firm names in the same country. */
export function isDistinctiveName(
  nameNorm: string,
  tokenFrequency: (token: string) => number,
  maxFreq: number = MATCH_CONFIG.link.distinctiveTokenMaxFreq,
): boolean {
  // Legal-words-only and empty names are never distinctive (spec §8.2).
  if (!isUsableName(nameNorm)) return false;
  const tokens = nameNorm.split(' ').filter(Boolean);
  return Math.min(...tokens.map(tokenFrequency)) < maxFreq;
}
