import { z } from 'zod';
import { DESTINATIONS, type Destination } from './destinations';
import { NOTICE_SOURCES, type NoticeSource, type NoticeType } from './ingestion';
import { HAZARD_CATEGORIES, type HazardCategoryId } from './taxonomy';
import type { FreshnessSource } from './product';

/** `a,b,c` into a list, dropping blanks and repeats; every item must be one of `allowed`. */
function commaList<const T extends readonly [string, ...string[]]>(allowed: T) {
  return z
    .string()
    .transform((text) => [...new Set(text.split(',').map((part) => part.trim()).filter((part) => part !== ''))])
    .pipe(z.array(z.enum(allowed)).min(1));
}

/** A decimal id that fits a Postgres `integer` (`1e3`, signs and spaces are refused; an out-of-range value would be a 500 in the query). */
const positiveInt = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/, 'must be a positive whole number')
  .transform(Number)
  .pipe(z.number().max(2147483647));

/** `GET /v1/notices` (spec §7.3, P5-D5): every filter is optional and they combine with AND. */
export const noticeSearchQuery = z.object({
  /** Border regions, for example `US,AU`. */
  destination: commaList(DESTINATIONS).optional(),
  origin: z.string().regex(/^[A-Z]{2}$/).optional(),
  /** A commodity; its descendants match too (P5-D6). */
  commodity: positiveInt.optional(),
  hazard: positiveInt.optional(),
  hazardCategory: z.enum(HAZARD_CATEGORIES).optional(),
  /** Notice sources, for example `fda_refusal,rasff`. */
  source: commaList(NOTICE_SOURCES).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Free text in the product description. */
  q: z.string().trim().min(3).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
});
export type NoticeSearchQuery = z.output<typeof noticeSearchQuery>;

export interface NoticeItem {
  id: number;
  source: NoticeSource;
  noticeType: NoticeType;
  destination: Destination;
  /** `YYYY-MM-DD`. */
  noticeOn: string;
  originCountry: string | null;
  commodityId: number | null;
  hazardIds: number[];
  productText: string | null;
  firmName: string | null;
  firmId: number | null;
  title: string | null;
  url: string | null;
}

export interface NoticeSearchResponse {
  items: NoticeItem[];
  /** The cursor of the next page; null on the last. */
  next: string | null;
  /** The first day the account's plan reaches (`YYYY-MM-DD`), or null for all history. */
  historyFrom: string | null;
}

/** How recent a source's last successful sync is. */
export interface SourceFreshness {
  source: FreshnessSource;
  /** ISO timestamp of the latest complete, successful sync; null when there is none. */
  lastSuccessAt: string | null;
  stale: boolean;
  /** `YYYY-MM` of the newest record, for the monthly files (`uk_bn`, `au_ifis`); null otherwise. */
  latestMonth: string | null;
}

/** `GET /v1/dashboards/topic` (spec §7.3, P5-D7): a topic is an origin, optionally narrowed by commodity (and its descendants) and destinations. */
export const dashboardQuery = z.object({
  origin: z.string().regex(/^[A-Z]{2}$/),
  commodity: positiveInt.optional(),
  /** Border regions, for example `US,AU`. */
  destination: commaList(DESTINATIONS).optional(),
});
export type DashboardQuery = z.output<typeof dashboardQuery>;

/** Counts per destination. */
export type DestinationCounts = Record<Destination, number>;

export interface DashboardResponse {
  /** One entry per calendar month (UTC), oldest first, zero-filled: 36, or fewer when the plan's history is shorter. */
  months: ({ month: string } & DestinationCounts)[];
  /** The last 12 months. */
  totals12m: DestinationCounts;
  /** The top 6 hazard categories of the last 12 months; a notice counts once for each category among its hazards. */
  hazardCategories: { category: HazardCategoryId; count: number }[];
  /** The 10 most frequent hazards of the last 12 months; a notice counts once for each of its hazards. */
  findings: { hazardId: number; count: number; byDestination: DestinationCounts }[];
  /** The top 6 commodities of the last 12 months (the notices' own commodity, not its ancestors). */
  commodities: { commodityId: number; count: number }[];
  /** The 20 newest notices in the account's history window. */
  latest: NoticeItem[];
  historyFrom: string | null;
  freshness: SourceFreshness[];
}
