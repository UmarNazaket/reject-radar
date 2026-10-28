import { z } from 'zod';
import { BILLING_INTERVALS, type BillingInterval, type SubscriptionStatus } from './accounts';
import type { ApiEnv } from './env';
import type { PlanId, PlanLimits } from './plans';

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

/** One plan on the public price list (P7-D11). `prices` holds the Paddle price ids and is null for Free and Enterprise. */
export interface PlanSummary {
  id: PlanId;
  name: string;
  monthlyPriceUsd: number | null;
  yearlyPriceUsd: number | null;
  limits: PlanLimits;
  prices: { month: string; year: string } | null;
}

export interface PlansResponse {
  plans: PlanSummary[];
}

/** Where an account's plan comes from: an admin's `plan_override`, a paid Paddle subscription, or nothing (P7-D11). */
export type PlanSource = 'override' | 'subscription' | 'free';

/** What the account has used this UTC month, next to the limits in `SubscriptionResponse`. */
export interface BillingUsage {
  period: string;
  lookups: number;
  bulkRows: number;
  apiCalls: number;
  watchlist: number;
  members: number;
}

/** `GET /billing/subscription`: the resolved plan, the Paddle state behind it, and this month's usage (P7-D11). */
export interface SubscriptionResponse {
  plan: PlanId;
  source: PlanSource;
  /** The Paddle subscription's status; null while the account has never had one. */
  status: SubscriptionStatus | null;
  interval: BillingInterval | null;
  currentPeriodEnd: string | null;
  /** A scheduled cancellation, when there is one. */
  cancelAt: string | null;
  /** True once the account has a Paddle customer, so the portal is available. */
  hasBillingAccount: boolean;
  /** True for an owner: only an owner starts checkout or opens the portal. */
  canManage: boolean;
  limits: PlanLimits;
  usage: BillingUsage;
}

/** `POST /billing/checkout`: what the owner wants to buy. Enterprise and Free are not sold here (P7-D8). */
export const checkoutRequest = z.object({ plan: z.enum(PAID_PLAN_IDS), interval: z.enum(BILLING_INTERVALS) });
export type CheckoutRequest = z.infer<typeof checkoutRequest>;

/** What the web app's Paddle.js overlay needs to open checkout (spec §10.2, P7-D8). */
export interface CheckoutResponse {
  priceId: string;
  /** Exactly `{ orgId }`: the webhook finds the account from it (P7-D4). */
  customData: { orgId: string };
  customerEmail: string;
  clientToken: string;
  environment: PaddleEnv;
  /** Where Paddle returns the buyer; the billing page polls until the webhook lands (P9). */
  successUrl: string;
}
