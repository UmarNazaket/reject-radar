export interface LinkConfig {
  /** Weight of the name similarity. */
  name: number;
  /** Bonus for a matching normalised address. */
  address: number;
  /** Bonus for an exact name that is distinctive within the country. */
  distinctiveExactName: number;
  /** Bonus for the same postal code. */
  postalCode: number;
  /** Bonus for the same city. */
  city: number;
  /** Bonus for the same region. */
  region: number;
  /** Floor bonus for any same-country pair. */
  sameCountry: number;
  /** Bonus for at least one shared commodity. */
  product: number;
  /** Score at or above which two records link automatically. */
  autoLink: number;
  /** Score at or above which two records go to review. */
  review: number;
  /** Minimum trigram similarity for a candidate. */
  candidateMinTrigram: number;
  /** Minimum Jaro-Winkler for two name words to count as the same word in the name similarity. */
  nameTokenMinJw: number;
  /** Maximum candidates considered per record. */
  maxCandidates: number;
  /** A name token is distinctive when it appears in fewer firm names than this. */
  distinctiveTokenMaxFreq: number;
  /** Minimum address similarity for an address match. */
  addressMinSim: number;
  /** Minimum address words before an address can match. */
  addressMinTokens: number;
}

export interface QueryConfig {
  /** Weight of the query-to-name similarity. */
  name: number;
  /** Bonus when the query city equals the firm city. */
  city: number;
  /** Bonus when this is the only near-exact result. */
  unique: number;
  /** Similarity at or above which a result counts as near-exact. */
  uniqueMinSim: number;
  /** Score at or above which a result is labelled strong. */
  strong: number;
  /** Score at or above which a result is labelled possible. */
  possible: number;
  /** Score at or above which a result is labelled other. */
  other: number;
  /** Maximum results returned. */
  limit: number;
}

export interface BulkConfig {
  /** Score at or above which a bulk row counts as matched. */
  matched: number;
  /** Score at or above which a bulk row counts as review. */
  review: number;
  /** Candidates kept per bulk row. */
  keepCandidates: number;
}

export interface MatchConfig {
  link: LinkConfig;
  query: QueryConfig;
  bulk: BulkConfig;
}

/** Every weight and threshold from spec §8.2–§8.4. Starting values; phase 3 tunes them on the labelled set. */
export const MATCH_CONFIG: Readonly<MatchConfig> = {
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
    nameTokenMinJw: 0.92,
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
};

/** Round to 4 decimals so threshold comparisons are not defeated by floating-point noise. */
export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
