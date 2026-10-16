import { MATCH_CONFIG, round4 } from './config';
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

export function buildLinkEvidence(
  record: MatchRecord,
  candidate: MatchRecord,
  opts: { isDistinctive: boolean },
  cfg: typeof MATCH_CONFIG.link = MATCH_CONFIG.link,
): LinkEvidence {
  const a = record.address;
  const b = candidate.address;
  // Spec §8.2: records in different countries, or with an unknown country, are never linked.
  const sameCountry = !!a?.countryCode && a.countryCode === b?.countryCode;
  const same = (x: string | null | undefined, y: string | null | undefined) => sameCountry && !!x && x === y;
  // Review focus 1: an empty or legal-words-only name carries no name evidence, so it can never reach the link band.
  const usableNames = isUsableName(record.nameNorm) && isUsableName(candidate.nameNorm);

  return {
    nameSim: usableNames ? nameSimilarity(record.nameNorm, candidate.nameNorm) : 0,
    sameCountry,
    addressMatch:
      sameCountry &&
      addressSimilarity(a?.addressNorm ?? null, b?.addressNorm ?? null, cfg.addressMinTokens) >= cfg.addressMinSim,
    exactDistinctiveName: usableNames && opts.isDistinctive && record.nameNorm === candidate.nameNorm,
    postalMatch: same(a?.postalCode, b?.postalCode),
    cityMatch: same(a?.city, b?.city),
    regionMatch: same(a?.region, b?.region),
    productOverlap: record.commodityIds.some((id) => candidate.commodityIds.includes(id)),
  };
}

export function linkScore(e: LinkEvidence, cfg: typeof MATCH_CONFIG.link = MATCH_CONFIG.link): number {
  if (!e.sameCountry) return 0;
  const locationBonus = Math.max(
    e.addressMatch ? cfg.address : 0,
    e.exactDistinctiveName ? cfg.distinctiveExactName : 0,
    e.postalMatch ? cfg.postalCode : 0,
    e.cityMatch ? cfg.city : 0,
    e.regionMatch ? cfg.region : 0,
    cfg.sameCountry,
  );
  const score = cfg.name * e.nameSim + locationBonus + (e.productOverlap ? cfg.product : 0);
  return Math.min(1, round4(score));
}

export function decideLink(score: number, cfg: typeof MATCH_CONFIG.link = MATCH_CONFIG.link): LinkDecision {
  if (score >= cfg.autoLink) return 'link';
  if (score >= cfg.review) return 'review';
  return 'new';
}
