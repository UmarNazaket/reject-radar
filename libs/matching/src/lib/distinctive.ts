import { MATCH_CONFIG } from './config';

/** A name is distinctive when its rarest token appears in fewer than `maxFreq` firm names in the same country. */
export function isDistinctiveName(
  nameNorm: string,
  tokenFrequency: (token: string) => number,
  maxFreq: number = MATCH_CONFIG.link.distinctiveTokenMaxFreq,
): boolean {
  const tokens = nameNorm.split(' ').filter(Boolean);
  if (tokens.length === 0) return false;
  return Math.min(...tokens.map(tokenFrequency)) < maxFreq;
}
