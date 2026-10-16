import { labelQueryScore, queryScore } from './query-score';

const base = { sim: 0, cityMatch: false, uniqueNearExact: false };

describe('queryScore (spec §8.3 examples)', () => {
  it('exact name + city = 0.91 → strong', () => {
    const score = queryScore({ ...base, sim: 1, cityMatch: true });
    expect(score).toBe(0.91);
    expect(labelQueryScore(score)).toBe('strong');
  });
  it('exact name shared with other firms = 0.85 → possible', () => {
    expect(labelQueryScore(queryScore({ ...base, sim: 1 }))).toBe('possible');
  });
  it('exact name only one firm has = 0.90 → strong', () => {
    const score = queryScore({ ...base, sim: 1, uniqueNearExact: true });
    expect(score).toBe(0.9);
    expect(labelQueryScore(score)).toBe('strong');
  });
  it('adds every bonus once', () => {
    expect(queryScore({ sim: 1, cityMatch: true, uniqueNearExact: true })).toBe(0.96);
  });
  it.each([
    [0.9, 'strong'],
    [0.75, 'possible'],
    [0.5, 'other'],
    [0.4999, 'hidden'],
  ] as const)('labels %p as %p', (score, label) => {
    expect(labelQueryScore(score)).toBe(label);
  });
});
