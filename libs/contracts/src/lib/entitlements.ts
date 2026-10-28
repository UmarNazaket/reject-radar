import { z } from 'zod';
import { PLAN_IDS } from './plans';

/** What a counted limit guards (P5-D1). */
export const LIMIT_ACTIONS = ['lookup', 'watchlist', 'members', 'bulk_rows', 'api_calls'] as const;
export type LimitAction = (typeof LIMIT_ACTIONS)[number];

/** What a plan can lack altogether (P5-D1). */
export const PLAN_FEATURES = ['pdf', 'bulk', 'api', 'notice_history'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** The `details` of a `403 PLAN_LIMIT_REACHED`. */
export const planLimitDetailsSchema = z.object({
  action: z.enum(LIMIT_ACTIONS),
  plan: z.enum(PLAN_IDS),
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
});
export type PlanLimitDetails = z.infer<typeof planLimitDetailsSchema>;

/** The `details` of a `403 PLAN_UPGRADE_REQUIRED`. */
export const planUpgradeDetailsSchema = z.object({
  feature: z.enum(PLAN_FEATURES),
  plan: z.enum(PLAN_IDS),
});
export type PlanUpgradeDetails = z.infer<typeof planUpgradeDetailsSchema>;
