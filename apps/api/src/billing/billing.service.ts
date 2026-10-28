import { Inject, Injectable } from '@nestjs/common';
import {
  type ApiEnv,
  PAID_PLAN_IDS,
  type PaidPlanId,
  PLAN_IDS,
  PLANS,
  type PlanSummary,
  type PlansResponse,
  priceCatalog,
  type PriceCatalog,
  type SubscriptionResponse,
} from '@rejectradar/contracts';
import { type Database, subscription } from '@rejectradar/db';
import { byOrg, type RequestContext } from '../auth/context';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { MembersService } from '../orgs/members.service';
import { WatchlistsService } from '../watchlists/watchlists.service';

const isPaidPlan = (id: string): id is PaidPlanId => (PAID_PLAN_IDS as readonly string[]).includes(id);

/** What an account pays for and how much of it is used (spec §10, P7-D11). Checkout, webhooks and the portal join it in later tasks. */
@Injectable()
export class BillingService {
  private readonly catalog: PriceCatalog;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_ENV) env: ApiEnv,
    private readonly entitlements: EntitlementsService,
    private readonly members: MembersService,
    private readonly watchlists: WatchlistsService,
  ) {
    this.catalog = priceCatalog(env);
  }

  /** The public price list: every plan with its limits, and the Paddle price ids of the two that checkout sells. */
  plans(): PlansResponse {
    const plans = PLAN_IDS.map((id): PlanSummary => {
      const { id: _id, name, monthlyPriceUsd, yearlyPriceUsd, ...limits } = PLANS[id];
      const prices = isPaidPlan(id) ? { month: this.catalog.priceFor(id, 'month'), year: this.catalog.priceFor(id, 'year') } : null;
      return { id, name, monthlyPriceUsd, yearlyPriceUsd, limits, prices };
    });
    return { plans };
  }

  /** The caller's plan and where it comes from, the Paddle state behind it, and this UTC month's usage. */
  async subscription(ctx: RequestContext): Promise<SubscriptionResponse> {
    const [{ plan, source, limits }, [row], usage, watchlist, members] = await Promise.all([
      this.entitlements.resolvePlan(ctx.orgId),
      this.db.select().from(subscription).where(byOrg(subscription, ctx)),
      this.entitlements.usage(ctx.orgId),
      this.watchlists.count(ctx.orgId),
      this.members.count(ctx.orgId),
    ]);
    // Sign-up leaves a free row without Paddle ids; its status says nothing a billing page should show.
    const paddle = row?.paddleSubscriptionId ? row : null;
    return {
      plan,
      source,
      status: paddle ? (paddle.status as SubscriptionResponse['status']) : null,
      interval: paddle ? (paddle.interval as SubscriptionResponse['interval']) : null,
      currentPeriodEnd: paddle?.currentPeriodEnd?.toISOString() ?? null,
      cancelAt: paddle?.cancelAt?.toISOString() ?? null,
      hasBillingAccount: Boolean(row?.paddleCustomerId),
      canManage: ctx.role === 'owner',
      limits,
      usage: { ...usage, watchlist, members },
    };
  }
}
