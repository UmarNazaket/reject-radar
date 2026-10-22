import { type LinkConfig, MATCH_CONFIG, round4 } from './config';
import { addressSimilarity, type NormalizedAddress } from './normalize-address';
import { isUsableName } from './normalize-name';
import { nameSimilarity } from './similarity';

export interface MatchRecord {
  nameNorm: string;
  address: NormalizedAddress | null;
  /** Taxonomy commodity IDs seen on the record (a firm: on all its records). */
  commodityIds: readonly number[];
}

export interface LinkEvidence {
  nameSim: number;
  sameCountry: boolean;
  addressMatch: boolean;
  exactDistinctiveName: boolean;
  postalMatch: boolean;
  cityMatch: boolean;
  regionMatch: boolean;
  productOverlap: boolean;
}

export type LinkDecision = 'link' | 'review' | 'new';

/** The evidence a location bonus is given for. */
export type LocationReason = 'address' | 'distinctive_exact_name' | 'postal_code' | 'city' | 'region' | 'same_country';

/** The three terms of the score (spec §8.2), kept apart so that a review row can show how a pair scored. */
export interface LinkScoreParts {
  /** `cfg.name × nameSim`, rounded to 4 decimals. */
  name: number;
  /** The single highest location bonus that applies. */
  location: number;
  /** The evidence that earned `location`; null when the records are not in the same country. */
  locationReason: LocationReason | null;
  /** The product bonus, 0 without a shared commodity. */
  product: number;
  /** The three parts added, capped at 1 and rounded to 4 decimals. This is the score. */
  total: number;
}

/** Spaces do not tell cities apart: "Zhanjiang" and "Zhan Jiang" are one city (P3-D3). */
const withoutSpaces = (city: string | null | undefined) => city?.replace(/ /g, '');

export function buildLinkEvidence(
  record: MatchRecord,
  candidate: MatchRecord,
  opts: { isDistinctive: boolean },
  cfg: LinkConfig = MATCH_CONFIG.link,
): LinkEvidence {
  const a = record.address;
  const b = candidate.address;
  // Spec §8.2: records in different countries, or with an unknown country, are never linked.
  const sameCountry = !!a?.countryCode && a.countryCode === b?.countryCode;
  const same = (x: string | null | undefined, y: string | null | undefined) => sameCountry && !!x && x === y;
  // Review focus 1: an empty or legal-words-only name carries no name evidence, so it can never reach the link band.
  const usableNames = isUsableName(record.nameNorm) && isUsableName(candidate.nameNorm);

  return {
    nameSim: usableNames ? nameSimilarity(record.nameNorm, candidate.nameNorm, cfg.nameTokenMinJw) : 0,
    sameCountry,
    addressMatch:
      sameCountry &&
      addressSimilarity(a?.addressNorm ?? null, b?.addressNorm ?? null, cfg.addressMinTokens) >= cfg.addressMinSim,
    exactDistinctiveName: usableNames && opts.isDistinctive && record.nameNorm === candidate.nameNorm,
    postalMatch: same(a?.postalCode, b?.postalCode),
    cityMatch: same(withoutSpaces(a?.city), withoutSpaces(b?.city)),
    regionMatch: same(a?.region, b?.region),
    productOverlap: record.commodityIds.some((id) => candidate.commodityIds.includes(id)),
  };
}

/** Spec §8.2 score, term by term. Records in different countries score 0 in every term. */
export function linkScoreParts(e: LinkEvidence, cfg: LinkConfig = MATCH_CONFIG.link): LinkScoreParts {
  if (!e.sameCountry) return { name: 0, location: 0, locationReason: null, product: 0, total: 0 };
  const bonuses: readonly (readonly [LocationReason, boolean, number])[] = [
    ['address', e.addressMatch, cfg.address],
    ['distinctive_exact_name', e.exactDistinctiveName, cfg.distinctiveExactName],
    ['postal_code', e.postalMatch, cfg.postalCode],
    ['city', e.cityMatch, cfg.city],
    ['region', e.regionMatch, cfg.region],
    ['same_country', true, cfg.sameCountry],
  ];
  // The bonuses are listed in order of preference and only a strictly higher one replaces the best so far, so a tie goes to
  // the earlier one. The same-country floor always applies.
  const [locationReason, , location] = bonuses
    .filter(([, applies]) => applies)
    .reduce((best, bonus) => (bonus[2] > best[2] ? bonus : best));
  const name = cfg.name * e.nameSim;
  const product = e.productOverlap ? cfg.product : 0;
  return {
    name: round4(name),
    location,
    locationReason,
    product,
    total: Math.min(1, round4(name + location + product)),
  };
}

export function linkScore(e: LinkEvidence, cfg: LinkConfig = MATCH_CONFIG.link): number {
  return linkScoreParts(e, cfg).total;
}

export function decideLink(score: number, cfg: LinkConfig = MATCH_CONFIG.link): LinkDecision {
  if (score >= cfg.autoLink) return 'link';
  if (score >= cfg.review) return 'review';
  return 'new';
}
