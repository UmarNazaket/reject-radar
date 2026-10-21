import { trigrams } from '@rejectradar/matching';

/**
 * Firm names looked up by trigram similarity, in memory (P3-D1). A search selects the items PostgreSQL's
 * `similarity(name, query) >= minSim` would, and also those added earlier in the same run, which a query cannot see.
 * An inverted index (trigram to items) means it visits only the items that share a trigram with the query.
 */
export class CandidateIndex<T> {
  private readonly items: T[] = [];
  /** The number of distinct trigrams in each item's name, by position. */
  private readonly trigramCounts: number[] = [];
  /** Trigram to the positions of the items whose name has it, in the order they were added. */
  private readonly postings = new Map<string, number[]>();
  /** Scratch space for `search`: trigrams shared with the query, by position. All zero between searches. */
  private sharedCounts = new Int32Array(0);

  /** How many items were added, names without letters or digits included. */
  get size(): number {
    return this.items.length;
  }

  add(nameNorm: string, item: T): void {
    const position = this.items.length;
    const grams = trigrams(nameNorm);
    this.items.push(item);
    this.trigramCounts.push(grams.size);
    for (const gram of grams) {
      const positions = this.postings.get(gram);
      if (positions) positions.push(position);
      else this.postings.set(gram, [position]);
    }
  }

  /**
   * Items with pg_trgm similarity ≥ minSim, by similarity desc, then insertion order; at most `limit`.
   * `sim` is exactly `trigramSimilarity(nameNorm, name)`. An item must share a trigram with the query to be found,
   * so a query or a name without letters or digits finds nothing, whatever `minSim` is.
   */
  search(nameNorm: string, opts: { minSim: number; limit: number }): { item: T; sim: number }[] {
    const query = trigrams(nameNorm);
    if (this.sharedCounts.length < this.items.length) {
      // Doubling keeps this rare when adds and searches alternate. The old counters are all zero: nothing to copy.
      this.sharedCounts = new Int32Array(Math.max(this.items.length, 2 * this.sharedCounts.length));
    }
    const touched: number[] = [];
    for (const gram of query) {
      const positions = this.postings.get(gram);
      if (!positions) continue;
      for (const position of positions) {
        if (this.sharedCounts[position] === 0) touched.push(position);
        this.sharedCounts[position]++;
      }
    }
    const hits: { position: number; sim: number }[] = [];
    for (const position of touched) {
      const shared = this.sharedCounts[position];
      this.sharedCounts[position] = 0;
      // The same integer counts as trigramSimilarity, so the same floating-point value.
      const sim = shared / (query.size + this.trigramCounts[position] - shared);
      if (sim >= opts.minSim) hits.push({ position, sim });
    }
    // `touched` follows the query's trigrams, not insertion order, so equal similarities are ordered by position here.
    hits.sort((a, b) => b.sim - a.sim || a.position - b.position);
    return hits.slice(0, opts.limit).map(({ position, sim }) => ({ item: this.items[position], sim }));
  }
}
