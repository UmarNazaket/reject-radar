import type { BillingInterval } from './accounts';
import type { ApiEnv } from './env';

/** Which Paddle environment the API talks to. Staging runs `NODE_ENV=production` with `sandbox` (P7-D10). */
export const PADDLE_ENVS = ['sandbox', 'production'] as const;
export type PaddleEnv = (typeof PADDLE_ENVS)[number];

/** The plans checkout sells: Free has no price and Enterprise is granted by an admin (spec §10.1). */
export const PAID_PLAN_IDS = ['pro', 'business'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

/** A Paddle price and the plan and interval it sells. */
export interface PriceEntry {
  priceId: string;
  plan: PaidPlanId;
  interval: BillingInterval;
}

export interface PriceCatalog {
  /** From a Paddle price id (a webhook) to the plan it grants. */
  byPrice: ReadonlyMap<string, PriceEntry>;
  /** From a plan and interval (checkout) to the Paddle price id. */
  priceFor(plan: PaidPlanId, interval: BillingInterval): string;
}

type PriceEnv = Pick<
  ApiEnv,
  'PADDLE_PRICE_PRO_MONTHLY' | 'PADDLE_PRICE_PRO_YEARLY' | 'PADDLE_PRICE_BUSINESS_MONTHLY' | 'PADDLE_PRICE_BUSINESS_YEARLY'
>;

/** Builds the two-way price lookup from the four `PADDLE_PRICE_*` variables; the same id twice is a misconfiguration. */
export function priceCatalog(env: PriceEnv): PriceCatalog {
  const entries: PriceEntry[] = [
    { priceId: env.PADDLE_PRICE_PRO_MONTHLY, plan: 'pro', interval: 'month' },
    { priceId: env.PADDLE_PRICE_PRO_YEARLY, plan: 'pro', interval: 'year' },
    { priceId: env.PADDLE_PRICE_BUSINESS_MONTHLY, plan: 'business', interval: 'month' },
    { priceId: env.PADDLE_PRICE_BUSINESS_YEARLY, plan: 'business', interval: 'year' },
  ];
  const byPrice = new Map<string, PriceEntry>();
  for (const entry of entries) {
    if (byPrice.has(entry.priceId)) throw new Error(`Duplicate Paddle price id in the PADDLE_PRICE_* variables: ${entry.priceId}`);
    byPrice.set(entry.priceId, entry);
  }
  return {
    byPrice,
    priceFor(plan, interval) {
      const entry = entries.find((candidate) => candidate.plan === plan && candidate.interval === interval);
      if (!entry) throw new Error(`No Paddle price for ${plan}/${interval}`);
      return entry.priceId;
    },
  };
}
