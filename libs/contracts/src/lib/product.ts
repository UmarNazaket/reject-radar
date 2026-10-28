import type { Destination } from './destinations';

export const WATCHLIST_KINDS = ['firm', 'topic'] as const;
export type WatchlistKind = (typeof WATCHLIST_KINDS)[number];

export const DIGEST_FREQUENCIES = ['daily', 'weekly', 'off'] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export const DISPUTE_KINDS = ['wrong_firm', 'mixed_firms', 'wrong_details', 'other'] as const;
export type DisputeKind = (typeof DISPUTE_KINDS)[number];

export const DISPUTE_STATUSES = ['open', 'rejected', 'resolved'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/** The four parts of a watched topic (spec §7.2); null means "any". */
export interface TopicFields {
  originCountry: string;
  commodityId: number | null;
  destination: Destination | null;
  hazardId: number | null;
}

/** `<origin>|<commodity or *>|<destination or *>|<hazard or *>` (spec §7.2). */
export function buildTopicKey(t: TopicFields): string {
  return [t.originCountry, t.commodityId ?? '*', t.destination ?? '*', t.hazardId ?? '*'].join('|');
}

/** The UTC month as `YYYY-MM`, the period usage is counted in. */
export function utcPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export const FRESHNESS_SOURCES = ['fda_refusals', 'import_alerts', 'rasff', 'uk_bn', 'au_ifis', 'eu_mrl'] as const;
export type FreshnessSource = (typeof FRESHNESS_SOURCES)[number];

/** Days without a successful sync before a source is shown as stale. */
export const STALE_AFTER_DAYS: Record<FreshnessSource, number> = {
  import_alerts: 3,
  rasff: 3,
  fda_refusals: 14,
  uk_bn: 14,
  au_ifis: 14,
  eu_mrl: 45,
};
