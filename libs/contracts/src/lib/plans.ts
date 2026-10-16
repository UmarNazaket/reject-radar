export const PLAN_IDS = ['free', 'pro', 'business', 'enterprise'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** Firm profiles and firm PDFs per UTC month; the same firm again in the same month is free. */
  lookupsPerMonth: number;
  /** Watched firms and topics together. */
  watchlistSize: number;
  members: number;
  pdf: boolean;
  bulk: boolean;
  bulkRowsPerMonth: number;
  apiCallsPerMonth: number;
  /** How far back notice search and dashboards reach; null means all history. */
  noticeHistoryMonths: number | null;
}

export interface PlanDefinition extends PlanLimits {
  id: PlanId;
  name: string;
  /** USD per month; null when the plan is not self-serve. */
  monthlyPriceUsd: number | null;
  /** USD per year; null when the plan is not self-serve. */
  yearlyPriceUsd: number | null;
}

export const PLANS: Readonly<Record<PlanId, PlanDefinition>> = {
  free: {
    id: 'free', name: 'Free', monthlyPriceUsd: 0, yearlyPriceUsd: 0,
    lookupsPerMonth: 10, watchlistSize: 3, members: 1, pdf: false, bulk: false,
    bulkRowsPerMonth: 0, apiCallsPerMonth: 0, noticeHistoryMonths: 12,
  },
  pro: {
    id: 'pro', name: 'Pro', monthlyPriceUsd: 39, yearlyPriceUsd: 390,
    lookupsPerMonth: 200, watchlistSize: 25, members: 3, pdf: true, bulk: false,
    bulkRowsPerMonth: 0, apiCallsPerMonth: 0, noticeHistoryMonths: null,
  },
  business: {
    id: 'business', name: 'Business', monthlyPriceUsd: 149, yearlyPriceUsd: 1490,
    lookupsPerMonth: 2000, watchlistSize: 250, members: 10, pdf: true, bulk: true,
    bulkRowsPerMonth: 5000, apiCallsPerMonth: 10000, noticeHistoryMonths: null,
  },
  // Enterprise is granted by an admin (spec §10.1); these defaults apply until per-account custom limits exist.
  enterprise: {
    id: 'enterprise', name: 'Enterprise', monthlyPriceUsd: null, yearlyPriceUsd: null,
    lookupsPerMonth: 20000, watchlistSize: 2500, members: 50, pdf: true, bulk: true,
    bulkRowsPerMonth: 50000, apiCallsPerMonth: 100000, noticeHistoryMonths: null,
  },
};

export const BULK_MAX_ROWS = 5000;
export const BULK_MAX_BYTES = 2 * 1024 * 1024;

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}
