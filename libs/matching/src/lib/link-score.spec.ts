import { MATCH_CONFIG } from './config';
import {
  buildLinkEvidence,
  decideLink,
  type LinkEvidence,
  linkScore,
  linkScoreParts,
  type LocationReason,
  type MatchRecord,
} from './link-score';
import type { NormalizedAddress } from './normalize-address';

const none: LinkEvidence = {
  nameSim: 0,
  sameCountry: true,
  addressMatch: false,
  exactDistinctiveName: false,
  postalMatch: false,
  cityMatch: false,
  regionMatch: false,
  productOverlap: false,
};

describe('linkScore (spec §8.2 worked examples)', () => {
  it('exact name + same city + shared commodity = 0.90 → link', () => {
    const score = linkScore({ ...none, nameSim: 1, cityMatch: true, productOverlap: true });
    expect(score).toBe(0.9);
    expect(decideLink(score)).toBe('link');
  });
  it('generic exact name, same country only, shared commodity = 0.81 → review', () => {
    const score = linkScore({ ...none, nameSim: 1, productOverlap: true });
    expect(score).toBe(0.81);
    expect(decideLink(score)).toBe('review');
  });
  it('distinctive exact name without an address = 1.00 (capped) → link', () => {
    const score = linkScore({ ...none, nameSim: 1, exactDistinctiveName: true, productOverlap: true });
    expect(score).toBe(1);
    expect(decideLink(score)).toBe('link');
  });
  it('name 0.85 + same postal code + shared commodity = 0.8175 → review', () => {
    const score = linkScore({ ...none, nameSim: 0.85, postalMatch: true, productOverlap: true });
    expect(score).toBe(0.8175);
    expect(decideLink(score)).toBe('review');
  });
  it('name 0.92 + address match = 0.94 → link', () => {
    const score = linkScore({ ...none, nameSim: 0.92, addressMatch: true });
    expect(score).toBe(0.94);
    expect(decideLink(score)).toBe('link');
  });
  it('uses only the single highest location bonus', () => {
    expect(linkScore({ ...none, nameSim: 0.8, addressMatch: true, postalMatch: true, cityMatch: true, regionMatch: true })).toBe(0.85);
  });
  it('weak name similarity creates a new firm', () => {
    expect(decideLink(linkScore({ ...none, nameSim: 0.6, productOverlap: true }))).toBe('new');
  });
  it('never links across countries, even on an exact distinctive name (review focus 2)', () => {
    const score = linkScore({ ...none, sameCountry: false, nameSim: 1, exactDistinctiveName: true, productOverlap: true });
    expect(score).toBe(0);
    expect(decideLink(score)).toBe('new');
  });
});

describe('linkScoreParts', () => {
  const evidence = (patch: Partial<LinkEvidence>): LinkEvidence => ({ ...none, ...patch });

  it('splits the score into name, location and product, with the reason for the location bonus', () => {
    expect(linkScoreParts(evidence({ nameSim: 0.85, postalMatch: true, productOverlap: true }))).toEqual({
      name: 0.6375,
      location: 0.15,
      locationReason: 'postal_code',
      product: 0.03,
      total: 0.8175,
    });
  });

  it('shows the parts as they are when their sum is capped at 1', () => {
    expect(linkScoreParts(evidence({ nameSim: 1, exactDistinctiveName: true, productOverlap: true }))).toEqual({
      name: 0.75,
      location: 0.25,
      locationReason: 'distinctive_exact_name',
      product: 0.03,
      total: 1,
    });
  });

  it('rounds the name part to 4 decimals, like the total', () => {
    const parts = linkScoreParts(evidence({ nameSim: 15 / 23 }));
    expect(parts.name).toBe(0.4891);
    expect(parts.total).toBe(0.5191);
  });

  it('adds no product part without a shared commodity', () => {
    expect(linkScoreParts(evidence({ nameSim: 0.92, addressMatch: true }))).toEqual({
      name: 0.69,
      location: 0.25,
      locationReason: 'address',
      product: 0,
      total: 0.94,
    });
  });

  it.each<[string, Partial<LinkEvidence>, LocationReason | null]>([
    ['an address match', { nameSim: 0.92, addressMatch: true }, 'address'],
    ['an exact distinctive name', { nameSim: 1, exactDistinctiveName: true, productOverlap: true }, 'distinctive_exact_name'],
    ['a postal code', { nameSim: 0.85, postalMatch: true, productOverlap: true }, 'postal_code'],
    ['a city', { nameSim: 1, cityMatch: true, productOverlap: true }, 'city'],
    ['a region', { nameSim: 0.8, regionMatch: true }, 'region'],
    ['the country only', { nameSim: 1, productOverlap: true }, 'same_country'],
    ['another country', { sameCountry: false, nameSim: 1, exactDistinctiveName: true, productOverlap: true }, null],
  ])('names %s as the location bonus, and its total is linkScore', (_label, patch, reason) => {
    const parts = linkScoreParts(evidence(patch));
    expect(parts.locationReason).toBe(reason);
    expect(parts.total).toBe(linkScore(evidence(patch)));
  });

  it('names the single highest bonus when several apply', () => {
    const parts = linkScoreParts(evidence({ nameSim: 0.8, postalMatch: true, cityMatch: true, regionMatch: true }));
    expect(parts.location).toBe(0.15);
    expect(parts.locationReason).toBe('postal_code');
  });

  describe('when bonuses tie it prefers address, exact distinctive name, postal code, city, region, country', () => {
    it('by default, where address and exact distinctive name are both 0.25', () => {
      expect(linkScoreParts(evidence({ addressMatch: true, exactDistinctiveName: true })).locationReason).toBe('address');
    });

    // Every bonus equal, so that only the order decides.
    const flat = {
      ...MATCH_CONFIG.link,
      address: 0.1,
      distinctiveExactName: 0.1,
      postalCode: 0.1,
      city: 0.1,
      region: 0.1,
      sameCountry: 0.1,
    };
    it.each<[Partial<LinkEvidence>, LocationReason]>([
      [{ addressMatch: true, exactDistinctiveName: true, postalMatch: true, cityMatch: true, regionMatch: true }, 'address'],
      [{ exactDistinctiveName: true, postalMatch: true, cityMatch: true, regionMatch: true }, 'distinctive_exact_name'],
      [{ postalMatch: true, cityMatch: true, regionMatch: true }, 'postal_code'],
      [{ cityMatch: true, regionMatch: true }, 'city'],
      [{ regionMatch: true }, 'region'],
      [{}, 'same_country'],
    ])('with equal weights and %j it names %s', (patch, reason) => {
      expect(linkScoreParts(evidence(patch), flat).locationReason).toBe(reason);
    });
  });

  it('falls back to the same-country bonus when the evidence earns less than it', () => {
    const parts = linkScoreParts(evidence({ nameSim: 1, cityMatch: true }), { ...MATCH_CONFIG.link, city: 0.01 });
    expect(parts.location).toBe(0.03);
    expect(parts.locationReason).toBe('same_country');
  });

  it('is zero in every part when the records are not in the same country', () => {
    const elsewhere = evidence({
      sameCountry: false,
      nameSim: 1,
      exactDistinctiveName: true,
      cityMatch: true,
      productOverlap: true,
    });
    expect(linkScoreParts(elsewhere)).toEqual({ name: 0, location: 0, locationReason: null, product: 0, total: 0 });
    expect(linkScore(elsewhere)).toBe(0);
  });

  it('uses the weights it is given', () => {
    const weights = { ...MATCH_CONFIG.link, name: 0.5, city: 0.2, product: 0.1 };
    const parts = linkScoreParts(evidence({ nameSim: 1, cityMatch: true, productOverlap: true }), weights);
    expect(parts).toEqual({ name: 0.5, location: 0.2, locationReason: 'city', product: 0.1, total: 0.8 });
  });
});

describe('decideLink thresholds', () => {
  it.each([
    [0.9, 'link'],
    [0.8999, 'review'],
    [0.75, 'review'],
    [0.7499, 'new'],
  ] as const)('%p → %p', (score, expected) => {
    expect(decideLink(score)).toBe(expected);
  });
  it('accepts a tuned override whose numbers differ from the defaults', () => {
    expect(decideLink(0.85, { ...MATCH_CONFIG.link, autoLink: 0.8 })).toBe('link');
  });
});

const addr = (
  countryCode: string | null,
  city: string | null,
  postalCode: string | null,
  addressNorm: string | null,
  region: string | null = null,
): NormalizedAddress => ({ countryCode, region, city, postalCode, addressNorm });

describe('buildLinkEvidence', () => {
  const firmRecord: MatchRecord = {
    nameNorm: 'al rahman rice mills',
    address: addr('PK', 'karachi', '74900', 'plot 12 sector 7 a korangi industrial area', 'sindh'),
    commodityIds: [3],
  };

  it('finds every match when the addresses agree', () => {
    const e = buildLinkEvidence({ ...firmRecord }, firmRecord, { isDistinctive: false });
    expect(e).toMatchObject({
      nameSim: 1,
      sameCountry: true,
      addressMatch: true,
      postalMatch: true,
      cityMatch: true,
      regionMatch: true,
      productOverlap: true,
      exactDistinctiveName: false,
    });
  });

  it('gives no location evidence across countries, even for the same city name', () => {
    const indian: MatchRecord = { ...firmRecord, address: addr('IN', 'karachi', '74900', 'plot 12 sector 7 a korangi industrial area', 'sindh') };
    expect(buildLinkEvidence(indian, firmRecord, { isDistinctive: true })).toMatchObject({
      sameCountry: false,
      addressMatch: false,
      postalMatch: false,
      cityMatch: false,
      regionMatch: false,
    });
  });

  it('treats an unknown country as no match', () => {
    const unknown: MatchRecord = { ...firmRecord, address: addr(null, 'karachi', null, null) };
    expect(buildLinkEvidence(unknown, firmRecord, { isDistinctive: true }).sameCountry).toBe(false);
  });

  describe('city (P3-D3: spaces do not count)', () => {
    /** Whether two records in the given countries, with the given cities, have the same city. */
    const sameCity = (cityA: string | null, cityB: string | null, countryB = 'CN'): boolean => {
      const inCity = (country: string, city: string | null): MatchRecord => ({
        ...firmRecord,
        address: addr(country, city, null, null),
      });
      return buildLinkEvidence(inCity('CN', cityA), inCity(countryB, cityB), { isDistinctive: false }).cityMatch;
    };

    it('matches "zhanjiang" and "zhan jiang" in the same country, whichever side has the space', () => {
      expect(sameCity('zhanjiang', 'zhan jiang')).toBe(true);
      expect(sameCity('zhan jiang', 'zhanjiang')).toBe(true);
      expect(sameCity('ho chi minh city', 'hochiminh city')).toBe(true);
    });

    it('still matches equal cities and still separates different ones', () => {
      expect(sameCity('zhan jiang', 'zhan jiang')).toBe(true);
      expect(sameCity('fuqing', 'fuzhou')).toBe(false);
      expect(sameCity('new castle', 'newcastle upon tyne')).toBe(false);
    });

    it('needs a city on both sides and the same country', () => {
      expect(sameCity(null, null)).toBe(false);
      expect(sameCity('zhanjiang', null)).toBe(false);
      expect(sameCity('zhanjiang', 'zhan jiang', 'TW')).toBe(false);
    });

    it('feeds the city bonus into the score', () => {
      const inCity = (city: string): MatchRecord => ({ ...firmRecord, address: addr('CN', city, null, null) });
      const e = buildLinkEvidence(inCity('zhanjiang'), inCity('zhan jiang'), { isDistinctive: false });
      expect(linkScoreParts(e)).toMatchObject({ location: 0.12, locationReason: 'city' });
    });
  });

  describe('name word threshold', () => {
    const named = (nameNorm: string): MatchRecord => ({ ...firmRecord, nameNorm });

    it('takes the pairing threshold for words from the config (P3-D2)', () => {
      const foods = named('abc foods');
      const food = named('abc food');
      const strict = { ...MATCH_CONFIG.link, nameTokenMinJw: 0.99 };
      // foods / food score 0.96 as words: paired at the default 0.92, apart at 0.99, where the trigram value 8 / 11 is larger.
      expect(buildLinkEvidence(foods, food, { isDistinctive: false }).nameSim).toBeCloseTo(0.98, 4);
      expect(buildLinkEvidence(foods, food, { isDistinctive: false }, strict).nameSim).toBeCloseTo(8 / 11, 4);
    });

    it('scores one differing word by its trigram share, not as a near-match: al noor vs al nasr', () => {
      const e = buildLinkEvidence(named('al noor rice mills'), named('al nasr rice mills'), { isDistinctive: false });
      expect(e.nameSim).toBeCloseTo(15 / 23, 4);
    });
  });

  it('needs at least 3 address words for an address match', () => {
    const shortA: MatchRecord = { ...firmRecord, address: addr('PK', null, null, 'main road') };
    const shortB: MatchRecord = { ...firmRecord, address: addr('PK', null, null, 'main road') };
    expect(buildLinkEvidence(shortA, shortB, { isDistinctive: false }).addressMatch).toBe(false);
  });

  it('flags an exact distinctive name only when names are equal and distinctive', () => {
    expect(buildLinkEvidence(firmRecord, firmRecord, { isDistinctive: true }).exactDistinctiveName).toBe(true);
    expect(buildLinkEvidence(firmRecord, firmRecord, { isDistinctive: false }).exactDistinctiveName).toBe(false);
    expect(
      buildLinkEvidence({ ...firmRecord, nameNorm: 'al rahman rice' }, firmRecord, { isDistinctive: true }).exactDistinctiveName,
    ).toBe(false);
  });

  it('sees no product overlap without a shared commodity', () => {
    expect(buildLinkEvidence({ ...firmRecord, commodityIds: [7] }, firmRecord, { isDistinctive: false }).productOverlap).toBe(false);
  });

  it('never auto-links a record whose name normalised to nothing (review focus 1)', () => {
    const blank: MatchRecord = { ...firmRecord, nameNorm: '' };
    const e = buildLinkEvidence(blank, { ...firmRecord, nameNorm: '' }, { isDistinctive: true });
    expect(e.nameSim).toBe(0);
    expect(e.exactDistinctiveName).toBe(false);
    expect(decideLink(linkScore(e))).toBe('new');
  });

  it('never auto-links a name made only of legal words, even with a full address match (review focus 1)', () => {
    const legalOnly: MatchRecord = { ...firmRecord, nameNorm: 'ltd' };
    const e = buildLinkEvidence(legalOnly, { ...legalOnly }, { isDistinctive: true });
    expect(e.nameSim).toBe(0);
    expect(e.exactDistinctiveName).toBe(false);
    expect(decideLink(linkScore(e))).toBe('new');
  });
});
