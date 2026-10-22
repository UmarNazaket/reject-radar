import { z } from 'zod';

/** Sources whose records name a firm and are linked to one. All are notice sources; RASFF and UK name no firms. */
export const FIRM_RECORD_SOURCES = ['fda_refusal', 'import_alert', 'au_ifis'] as const;
export type FirmRecordSource = (typeof FIRM_RECORD_SOURCES)[number];

/** Why a record was queued for review: its score fell in the review band, or linking would give a firm a second FEI. */
export const MATCH_REVIEW_REASONS = ['score_band', 'second_fei'] as const;
export type MatchReviewReason = (typeof MATCH_REVIEW_REASONS)[number];

/** A review stays `open` until decided: `linked` means the firms are the same, `kept_separate` that they are not. */
export const MATCH_REVIEW_STATUSES = ['open', 'linked', 'kept_separate'] as const;
export type MatchReviewStatus = (typeof MATCH_REVIEW_STATUSES)[number];

/** The windows firm facts count over; the `_12m` and `_3y` flag names and the `top_hazards_3y` cap follow from them. */
export const FIRM_FACT_WINDOWS = { recentMonths: 12, historyYears: 3, topHazards: 3 } as const;

const count = z.int().nonnegative();

/** An Import Alert listing a firm is on: the alert number and the day the firm was listed, if the page gives one. */
const alertListing = z.object({ alert: z.string(), listed_on: z.iso.date().nullable() });

/** `firm.flags`: the facts of the firm profile, under the names of spec §9.4. */
export const firmFlagsSchema = z.object({
  /** Current red-list listings on food Import Alerts, by alert number. */
  import_alert_red: z.array(alertListing),
  /** Current green-list listings on food Import Alerts, by alert number. */
  import_alert_green: z.array(alertListing),
  fda_refusals_12m: count,
  fda_refusals_3y: count,
  au_failed_3y: count,
  /** Whether the firm's latest Australian failure was marked as a holding-order match. */
  au_holding_order: z.boolean(),
  /** Hazard categories, most frequent first. */
  top_hazards_3y: z.array(z.string()).max(FIRM_FACT_WINDOWS.topHazards),
});
export type FirmFlags = z.output<typeof firmFlagsSchema>;

/** `firm.metrics`: all-time and current totals for the firm profile. */
export const firmMetricsSchema = z.object({
  fda_refusals_total: count,
  au_failed_total: count,
  import_alert_red_current: count,
  import_alert_green_current: count,
});
export type FirmMetrics = z.output<typeof firmMetricsSchema>;
