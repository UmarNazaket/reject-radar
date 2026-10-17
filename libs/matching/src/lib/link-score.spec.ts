import { MATCH_CONFIG } from './config';
import { buildLinkEvidence, decideLink, type LinkEvidence, linkScore, type MatchRecord } from './link-score';
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
