import { MATCH_CONFIG } from './config';
import {
  jaro,
  jaroWinkler,
  nameSimilarity,
  softTokenSetSimilarity,
  tokenSetJaroWinkler,
  trigramSimilarity,
  trigrams,
} from './similarity';

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

describe('tokenSetJaroWinkler (still scores addresses)', () => {
  it('ignores word order and repeated words', () => {
    expect(tokenSetJaroWinkler('rice mills rahman', 'rahman rice mills mills')).toBe(1);
  });
});

describe('softTokenSetSimilarity (P3-D2)', () => {
  it('counts a different word as a missing word: 3 shared words out of 4 + 4 - 3', () => {
    // al, rice and mills pair at 1; noor / nasr score 0.70 and stay apart.
    expect(softTokenSetSimilarity('al noor rice mills', 'al nasr rice mills')).toBeCloseTo(0.6, 4);
  });

  it('pairs a near-identical word at its Jaro-Winkler score', () => {
    // foods / food score 0.96, so (1 + 0.96) / (2 + 2 - 2) = 0.98.
    expect(softTokenSetSimilarity('abc foods', 'abc food')).toBeGreaterThan(0.95);
  });

  it('is 1 for identical strings and for the same words in another order', () => {
    expect(softTokenSetSimilarity('al noor rice mills', 'al noor rice mills')).toBe(1);
    expect(softTokenSetSimilarity('rice mills al noor', 'al noor rice mills')).toBe(1);
  });

  it('ignores repeated words', () => {
    expect(softTokenSetSimilarity('al noor al noor', 'al noor')).toBe(1);
  });

  it('is 0 when either side is empty', () => {
    expect(softTokenSetSimilarity('', 'al noor')).toBe(0);
    expect(softTokenSetSimilarity('al noor', '')).toBe(0);
    expect(softTokenSetSimilarity('', '')).toBe(0);
  });

  it('is 0 when no two words are alike', () => {
    expect(softTokenSetSimilarity('sunrise spices', 'qingdao haida')).toBe(0);
  });

  it('uses each word once', () => {
    // food pairs with food (1); foods finds no partner left: 1 / (2 + 1 - 1).
    expect(softTokenSetSimilarity('food foods', 'food')).toBe(0.5);
  });

  it('pairs the best-scoring words first, whatever the word order', () => {
    // rices pairs with rices (1). Giving it to rice (0.96) first would leave rices alone and score 0.48.
    expect(softTokenSetSimilarity('rice rices', 'rices')).toBe(0.5);
    expect(softTokenSetSimilarity('rices rice', 'rices')).toBe(0.5);
  });

  it('gives the same score from either side', () => {
    for (const [a, b] of [
      ['al noor rice mills', 'al nasr rice mills'],
      ['abc foods', 'abc food'],
      ['haji bashir ahmad and sons', 'haji bashir ahmad sons'],
      ['rice rices', 'rices'],
    ]) {
      expect(softTokenSetSimilarity(a, b)).toBe(softTokenSetSimilarity(b, a));
    }
  });

  it('pairs words only at or above the threshold it is given', () => {
    // foods / food score 0.96: paired at the default, apart at 0.99, so 1 / (2 + 2 - 1).
    expect(softTokenSetSimilarity('abc foods', 'abc food', 0.99)).toBeCloseTo(1 / 3, 4);
    // A word equal to its partner scores exactly 1, which still meets a threshold of 1.
    expect(softTokenSetSimilarity('abc foods', 'abc food', 1)).toBeCloseTo(1 / 3, 4);
    expect(softTokenSetSimilarity('abc', 'abc', 1)).toBe(1);
  });

  it('takes its default threshold from MATCH_CONFIG.link.nameTokenMinJw', () => {
    expect(MATCH_CONFIG.link.nameTokenMinJw).toBe(0.92);
    expect(softTokenSetSimilarity('abc foods', 'abc food')).toBe(
      softTokenSetSimilarity('abc foods', 'abc food', MATCH_CONFIG.link.nameTokenMinJw),
    );
  });
});

describe('nameSimilarity', () => {
  it('takes the larger of trigram and soft token-set similarity', () => {
    for (const [a, b] of [
      ['haji bashir ahmad and sons', 'haji bashir ahmad sons'],
      ['al noor rice mills', 'al nasr rice mills'],
      ['abc foods', 'abc food'],
    ]) {
      expect(nameSimilarity(a, b)).toBe(Math.max(trigramSimilarity(a, b), softTokenSetSimilarity(a, b)));
    }
    expect(nameSimilarity('', 'abc')).toBe(0);
  });

  it('lets the trigram value win when one word differs: al noor vs al nasr is 15 / 23, not 0.956', () => {
    expect(nameSimilarity('al noor rice mills', 'al nasr rice mills')).toBeCloseTo(15 / 23, 4);
  });

  it('lets the soft token-set value win when a word is spelt slightly differently', () => {
    expect(nameSimilarity('abc foods', 'abc food')).toBeCloseTo(0.98, 4);
  });

  it('passes the word threshold on to softTokenSetSimilarity', () => {
    // At 0.99 foods / food no longer pair, so the trigram value (8 / 11) is the larger.
    expect(nameSimilarity('abc foods', 'abc food', 0.99)).toBeCloseTo(8 / 11, 4);
  });

  it('is 1 for the same words in another order', () => {
    expect(nameSimilarity('rice mills al noor', 'al noor rice mills')).toBe(1);
  });
});
