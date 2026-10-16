import { MATCH_CONFIG, round4 } from './config';

export interface QueryEvidence {
  /** pg_trgm similarity between the query and firm.name_norm. */
  sim: number;
  /** City given by the user and equal to the firm's city. */
  cityMatch: boolean;
  /** This is the only result with sim ≥ 0.95. */
  uniqueNearExact: boolean;
}

export type QueryLabel = 'strong' | 'possible' | 'other' | 'hidden';

export function queryScore(e: QueryEvidence, cfg: typeof MATCH_CONFIG.query = MATCH_CONFIG.query): number {
  const score = cfg.name * e.sim + (e.cityMatch ? cfg.city : 0) + (e.uniqueNearExact ? cfg.unique : 0);
  return Math.min(1, round4(score));
}

export function labelQueryScore(score: number, cfg: typeof MATCH_CONFIG.query = MATCH_CONFIG.query): QueryLabel {
  if (score >= cfg.strong) return 'strong';
  if (score >= cfg.possible) return 'possible';
  if (score >= cfg.other) return 'other';
  return 'hidden';
}
