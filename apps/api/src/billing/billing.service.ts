import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type ApiEnv,
  type CheckoutRequest,
  type CheckoutResponse,
  isPaidSubscriptionStatus,
  PAID_PLAN_IDS,
  type PaidPlanId,
  PLAN_IDS,
  PLANS,
  type PlanSummary,
  type PlansResponse,
  type PortalResponse,
  priceCatalog,
  type PriceCatalog,
  type SubscriptionResponse,
} from '@rejectradar/contracts';
import { appUser, type Database, subscription } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { InvitesService } from '../orgs/invites.service';
import { MembersService } from '../orgs/members.service';
import { WatchlistsService } from '../watchlists/watchlists.service';
import { PADDLE_GATEWAY, type PaddleGateway } from './paddle/gateway';

const isPaidPlan = (id: string): id is PaidPlanId => (PAID_PLAN_IDS as readonly string[]).includes(id);

/** What an account pays for and how much of it is used (spec §10, P7-D11), what the owner needs to start a purchase (P7-D8) and the way into Paddle's portal (P7-D9). */
@Injectable()
export class BillingService {
  private readonly catalog: PriceCatalog;
  private readonly checkoutEnv: Pick<ApiEnv, 'APP_ORIGIN' | 'PADDLE_CLIENT_TOKEN' | 'PADDLE_ENV'>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_ENV) env: ApiEnv,
    private readonly entitlements: EntitlementsService,
    private readonly members: MembersService,
    private readonly invites: InvitesService,
    private readonly watchlists: WatchlistsService,
    @Inject(PADDLE_GATEWAY) private readonly paddle: PaddleGateway,
  ) {
    this.catalog = priceCatalog(env);
    this.checkoutEnv = env;
  }

  /** The public price list: every plan with its limits, and the Paddle price ids of the two that checkout sells. */
  plans(): PlansResponse {
    const plans = PLAN_IDS.map((id): PlanSummary => {
      const { id: planId, name, monthlyPriceUsd, yearlyPriceUsd, ...limits } = PLANS[id];
      const prices = isPaidPlan(id) ? { month: this.catalog.priceFor(id, 'month'), year: this.catalog.priceFor(id, 'year') } : null;
      return { id: planId, name, monthlyPriceUsd, yearlyPriceUsd, limits, prices };
    });
    return { plans };
  }

  /** The caller's plan and where it comes from, the Paddle state behind it, and this UTC month's usage. */
  async subscription(ctx: RequestContext): Promise<SubscriptionResponse> {
    const [{ plan, source, limits }, [row], usage, watchlist, members, seats] = await Promise.all([
      this.entitlements.resolvePlan(ctx.orgId),
      this.db.select().from(subscription).where(byOrg(subscription, ctx)),
      this.entitlements.usage(ctx.orgId),
      this.watchlists.count(ctx.orgId),
      this.members.count(ctx.orgId),
      this.invites.seats(ctx.orgId),
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
      usage: { ...usage, watchlist, members, seats },
    };
  }

  /**
   * What Paddle.js needs to open checkout for the owner's account (spec §10.2, P7-D8). Refused while a Paddle
   * subscription is still billing; a `plan_override` does not block it, and a canceled or paused one does not either.
   */
  async checkout(ctx: RequestContext, { plan, interval }: CheckoutRequest): Promise<CheckoutResponse> {
    const [[row], [user]] = await Promise.all([
      this.db.select({ status: subscription.status, paddleSubscriptionId: subscription.paddleSubscriptionId }).from(subscription).where(byOrg(subscription, ctx)),
      this.db.select({ email: appUser.email }).from(appUser).where(eq(appUser.id, ctx.userId)),
    ]);
    // A subscription that still bills the account would be charged twice by a second checkout.
    if (row?.paddleSubscriptionId && isPaidSubscriptionStatus(row.status)) {
      throw new AppError(HttpStatus.CONFLICT, 'ALREADY_SUBSCRIBED', 'The account already has a subscription; change it in the billing portal');
    }
    return {
      priceId: this.catalog.priceFor(plan, interval),
      customData: { orgId: ctx.orgId },
      customerEmail: user.email,
      clientToken: this.checkoutEnv.PADDLE_CLIENT_TOKEN,
      environment: this.checkoutEnv.PADDLE_ENV,
      successUrl: `${this.checkoutEnv.APP_ORIGIN}/app/settings/billing?checkout=success`,
    };
  }

  /**
   * A Paddle customer-portal URL for the owner's account (P7-D9). It needs a Paddle customer; the session lists the
   * account's current subscription, or none once it is canceled, so the owner can still reach invoices and payment details.
   */
  async portal(ctx: RequestContext): Promise<PortalResponse> {
    const [row] = await this.db
      .select({ customerId: subscription.paddleCustomerId, subscriptionId: subscription.paddleSubscriptionId, status: subscription.status })
      .from(subscription)
      .where(byOrg(subscription, ctx));
    if (!row?.customerId) throw new AppError(HttpStatus.CONFLICT, 'NO_BILLING_ACCOUNT', 'The account has no Paddle customer yet; subscribe to a plan first');
    const subscriptionIds = row.subscriptionId && row.status !== 'canceled' ? [row.subscriptionId] : [];
    return { url: await this.paddle.createPortalSession(row.customerId, subscriptionIds) };
  }
}
