import { jaro, jaroWinkler, nameSimilarity, tokenSetJaroWinkler, trigramSimilarity, trigrams } from './similarity';

describe('trigrams (pg_trgm semantics)', () => {
  it('pads each word with two leading spaces and one trailing space', () => {
    expect([...trigrams('cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat'].sort());
  });
});

describe('trigramSimilarity', () => {
  it("matches the PostgreSQL docs example similarity('word', 'two words') = 0.363636", () => {
    expect(trigramSimilarity('word', 'two words')).toBeCloseTo(0.363636, 5);
  });
  it('is 1 for identical names and 0 when either side is empty', () => {
    expect(trigramSimilarity('al rahman rice mills', 'al rahman rice mills')).toBe(1);
    expect(trigramSimilarity('', 'abc')).toBe(0);
    expect(trigramSimilarity('', '')).toBe(0);
  });
});

describe('jaro / jaroWinkler', () => {
  it.each([
    ['martha', 'marhta', 0.9444, 0.9611],
    ['dwayne', 'duane', 0.8222, 0.84],
    ['dixon', 'dicksonx', 0.7667, 0.8133],
  ])('%p vs %p', (a, b, expectedJaro, expectedJw) => {
    expect(jaro(a, b)).toBeCloseTo(expectedJaro, 4);
    expect(jaroWinkler(a, b)).toBeCloseTo(expectedJw, 4);
  });
  it('is 0 when either side is empty', () => {
    expect(jaro('', 'abc')).toBe(0);
    expect(jaroWinkler('', '')).toBe(0);
  });
});

describe('tokenSetJaroWinkler / nameSimilarity', () => {
  it('ignores word order and repeated words', () => {
    expect(tokenSetJaroWinkler('rice mills rahman', 'rahman rice mills mills')).toBe(1);
  });
  it('takes the larger of trigram and token-set Jaro-Winkler', () => {
    const a = 'haji bashir ahmad and sons';
    const b = 'haji bashir ahmad sons';
    expect(nameSimilarity(a, b)).toBe(Math.max(trigramSimilarity(a, b), tokenSetJaroWinkler(a, b)));
    expect(nameSimilarity('', 'abc')).toBe(0);
  });
});
