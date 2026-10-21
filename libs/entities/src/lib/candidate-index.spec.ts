import { trigramSimilarity } from '@rejectradar/matching';
import { CandidateIndex } from './candidate-index';

/** Normalised firm names in the styles the border records bring: Chinese, Indian, Pakistani and Vietnamese. */
const NAMES = [
  // Chinese
  'zhanjiang evergreen aquatic product',
  'zhanjiang evergreen aquatic products',
  'zhanjiang guolian aquatic products',
  'qingdao haida foodstuffs',
  'qingdao haida food',
  'qingdao huaxin foodstuffs',
  'dalian tiantian seafood',
  'shandong longda food',
  'fujian zhangzhou xinhua canned food',
  'guangzhou panyu spice trading',
  'weihai ocean aquatic',
  'yantai sea treasure aquatic',
  // Indian
  'gurudev spices',
  'gurudev masala',
  'shree gurudev spices',
  'sri ganesh rice mill',
  'shree ganesh rice mills',
  'bharat basmati exports',
  'ravi spice exports',
  'kerala spices and herbs',
  'jai balaji industries',
  'mahalaxmi rice industries',
  // Pakistani
  'al noor rice mills',
  'al noor rice mill',
  'al noor rice industries',
  'al nasr rice mills',
  'al rahman rice mills',
  'al rahman rice mills', // another firm under the same name
  'haji bashir ahmad and sons',
  'haji bashir ahmad sons',
  'karachi seafood exports',
  'lahore spice mills',
  'sheikh muhammad ali and brothers',
  'punjab flour mills',
  // Vietnamese
  'cong ty thuy san minh phu',
  'thuy san minh phu',
  'thuy san minh hai',
  'minh phu seafood',
  'hung vuong',
  'vinh hoan',
  'nam viet',
  'thuan phuoc seafoods and trading',
];

const OPTS = { minSim: 0.5, limit: 20 };

/** What a search must return, by definition: score every name, keep those at `minSim` or more, best first. */
function bruteForce(names: readonly string[], query: string, { minSim, limit } = OPTS) {
  return names
    .map((name, item) => ({ item, sim: trigramSimilarity(query, name) }))
    .filter(({ sim }) => sim >= minSim)
    .sort((a, b) => b.sim - a.sim || a.item - b.item)
    .slice(0, limit);
}

/** An index over `names`, each item being the name's position in the list. */
function buildIndex(names: readonly string[]): CandidateIndex<number> {
  const index = new CandidateIndex<number>();
  names.forEach((name, position) => index.add(name, position));
  return index;
}

describe('CandidateIndex', () => {
  // Shared by the tests that only search: a counter left over from one search would corrupt the next.
  const index = buildIndex(NAMES);

  it('counts the items added', () => {
    expect(new CandidateIndex<number>().size).toBe(0);
    expect(index.size).toBe(NAMES.length);
  });

  // The hit counts keep a comparison from passing on two empty lists.
  it.each<[string, number]>([
    ['zhanjiang evergreen aquatic product', 3],
    ['al noor rice mills', 5],
    ['gurudev spices', 2],
    ['cong ty thuy san minh phu', 2],
    ['al rahman rice mills', 4],
    ['haji bashir ahmad and sons', 2],
    ['qingdao haida foodstuf', 3],
    ['sunrise packaging works', 0],
  ])('%p has the same items, order and similarity as brute force (%i at 0.5 or more)', (query, hits) => {
    const expected = bruteForce(NAMES, query);
    expect(expected).toHaveLength(hits);
    expect(index.search(query, OPTS)).toEqual(expected);
  });

  it('gives pg_trgm similarity: 1 for the same name, 15 / 23 when one of four words differs', () => {
    const hits = index.search('al noor rice mills', OPTS);
    expect(hits[0]).toEqual({ item: NAMES.indexOf('al noor rice mills'), sim: 1 });
    expect(hits).toContainEqual({ item: NAMES.indexOf('al nasr rice mills'), sim: 15 / 23 });
  });

  it('returns at most `limit` items, the best ones', () => {
    const hits = index.search('al noor rice mills', { minSim: 0.5, limit: 3 });
    expect(hits).toHaveLength(3);
    expect(hits).toEqual(bruteForce(NAMES, 'al noor rice mills').slice(0, 3));
  });

  it('includes an item whose similarity equals minSim exactly', () => {
    // Five-letter words that differ in the last letter share 4 of their 6 trigrams: 4 / (6 + 6 - 4) = 0.5.
    expect(trigramSimilarity('nasir', 'nasim')).toBe(0.5);
    const small = buildIndex(['nasim']);
    expect(small.search('nasir', { minSim: 0.5, limit: 20 })).toEqual([{ item: 0, sim: 0.5 }]);
    expect(small.search('nasir', { minSim: 0.51, limit: 20 })).toEqual([]);
  });

  it('returns equal similarities in the order the items were added, not the order the query reaches them', () => {
    // Each name shares 13 of the query's 18 trigrams, so 13 / 18. The query reaches zaid's trigrams first,
    // but omar traders was added first.
    const small = buildIndex(['omar traders', 'zaid traders']);
    expect(small.search('zaid omar traders', OPTS)).toEqual([
      { item: 0, sim: 13 / 18 },
      { item: 1, sim: 13 / 18 },
    ]);
  });

  it('returns nothing for a query without letters or digits, whatever the cutoff', () => {
    for (const query of ['', '   ', '- -']) expect(index.search(query, { minSim: 0, limit: 20 })).toEqual([]);
  });

  it('counts a name without letters or digits but never returns it', () => {
    const small = new CandidateIndex<string>();
    small.add('', 'empty');
    small.add('- -', 'punctuation');
    small.add('al noor', 'al noor');
    expect(small.size).toBe(3);
    expect(small.search('al noor', { minSim: 0, limit: 20 })).toEqual([{ item: 'al noor', sim: 1 }]);
  });

  it('finds an item added after a search', () => {
    const growing = buildIndex(NAMES);
    expect(growing.search('sunrise packaging works', OPTS)).toEqual([]);
    growing.add('sunrise packaging works', NAMES.length);
    expect(growing.size).toBe(NAMES.length + 1);
    expect(growing.search('sunrise packaging works', OPTS)).toEqual([{ item: NAMES.length, sim: 1 }]);
  });

  it('agrees with brute force while items are added between searches', () => {
    const firsts = ['al', 'shree', 'haji', 'qingdao', 'minh', 'sheikh', 'jai'];
    const middles = ['noor', 'nasr', 'rahman', 'ganesh', 'haida', 'phu', 'bashir', 'balaji', 'tiantian'];
    const lasts = ['rice mills', 'spices', 'foods', 'seafood exports', 'flour mills', 'trading', 'industries'];
    const names = firsts.flatMap((a) => middles.flatMap((b) => lasts.map((c) => `${a} ${b} ${c}`)));
    const opts = { minSim: 0.5, limit: 10 };
    const growing = new CandidateIndex<number>();
    names.forEach((name, position) => {
      growing.add(name, position);
      if (position % 25 !== 0) return;
      // The name just added must be found, and so must the rest of its family.
      for (const query of [name, 'al noor rice mills']) {
        expect(growing.search(query, opts)).toEqual(bruteForce(names.slice(0, position + 1), query, opts));
      }
    });
    expect(growing.size).toBe(names.length);
  });
});
