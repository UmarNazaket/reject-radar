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

/** Jaro-Winkler on the sorted, de-duplicated word sets. */
export function tokenSetJaroWinkler(a: string, b: string): number {
  return jaroWinkler(tokenSet(a), tokenSet(b));
}

/** Spec §8.2: name_sim = max(trigram similarity, token-set Jaro-Winkler). */
export function nameSimilarity(a: string, b: string): number {
  return Math.max(trigramSimilarity(a, b), tokenSetJaroWinkler(a, b));
}

function tokenSet(value: string): string {
  return [...new Set(value.split(' ').filter(Boolean))].sort().join(' ');
}
