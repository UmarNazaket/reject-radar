/** Every weight and threshold from spec §8.2–§8.4. Starting values; phase 3 tunes them on the labelled set. */
export const MATCH_CONFIG = {
  link: {
    name: 0.75,
    address: 0.25,
    distinctiveExactName: 0.25,
    postalCode: 0.15,
    city: 0.12,
    region: 0.06,
    sameCountry: 0.03,
    product: 0.03,
    autoLink: 0.9,
    review: 0.75,
    candidateMinTrigram: 0.5,
    maxCandidates: 20,
    distinctiveTokenMaxFreq: 50,
    addressMinSim: 0.9,
    addressMinTokens: 3,
  },
  query: {
    name: 0.85,
    city: 0.06,
    unique: 0.05,
    uniqueMinSim: 0.95,
    strong: 0.9,
    possible: 0.75,
    other: 0.5,
    limit: 20,
  },
  bulk: {
    matched: 0.9,
    review: 0.75,
    keepCandidates: 3,
  },
} as const;

export type MatchConfig = typeof MATCH_CONFIG;

/** Round to 4 decimals so threshold comparisons are not defeated by floating-point noise. */
export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
