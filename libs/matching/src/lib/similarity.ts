import { MATCH_CONFIG } from './config';

/** Trigram set exactly as pg_trgm builds it: words of [a-z0-9], padded "  word ". */
export function trigrams(value: string): Set<string> {
  const set = new Set<string>();
  for (const word of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i <= padded.length - 3; i++) set.add(padded.slice(i, i + 3));
  }
  return set;
}

/** Same result as PostgreSQL `similarity(a, b)` from pg_trgm. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const gram of ta) if (tb.has(gram)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function jaro(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

export function jaroWinkler(a: string, b: string, prefixScale = 0.1): number {
  const base = jaro(a, b);
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return base + prefix * prefixScale * (1 - base);
}

/** Jaro-Winkler on the sorted, de-duplicated word sets. It scores addresses; names use softTokenSetSimilarity. */
export function tokenSetJaroWinkler(a: string, b: string): number {
  return jaroWinkler(tokenSet(a), tokenSet(b));
}

/**
 * Word-by-word similarity of two names (spec §8.2, P3-D2). Words are paired one-to-one when their Jaro-Winkler is at least
 * `minTokenJw`, best pair first (equal scores in word order), and the score is Σ(pair Jaro-Winkler) / (|A| + |B| − pairs).
 * A word without a partner counts like a missing word, however close its nearest neighbour is: Jaro-Winkler on the joined
 * words rated "al noor rice mills" / "al nasr rice mills" at 0.956, and this rates them 0.6.
 */
export function softTokenSetSimilarity(a: string, b: string, minTokenJw: number = MATCH_CONFIG.link.nameTokenMinJw): number {
  const wordsA = uniqueWords(a);
  const wordsB = uniqueWords(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const candidates: { i: number; j: number; jw: number }[] = [];
  wordsA.forEach((x, i) =>
    wordsB.forEach((y, j) => {
      const jw = jaroWinkler(x, y);
      if (jw >= minTokenJw) candidates.push({ i, j, jw });
    }),
  );
  // Array.prototype.sort is stable, so pairs with equal scores stay in the order the loops above produced them.
  candidates.sort((p, q) => q.jw - p.jw);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let total = 0;
  for (const { i, j, jw } of candidates) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    total += jw;
  }
  return total / (wordsA.length + wordsB.length - usedA.size);
}

/** Spec §8.2: name_sim = max(trigram similarity, soft token-set similarity); `minTokenJw` defaults to the config's. */
export function nameSimilarity(a: string, b: string, minTokenJw?: number): number {
  return Math.max(trigramSimilarity(a, b), softTokenSetSimilarity(a, b, minTokenJw));
}

/** The distinct words of `value`, in alphabetical order. */
function uniqueWords(value: string): string[] {
  return [...new Set(value.split(' ').filter(Boolean))].sort();
}

function tokenSet(value: string): string {
  return uniqueWords(value).join(' ');
}
