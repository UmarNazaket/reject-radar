import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { isPlanId, PLANS, type PlanId, type PlanLimitDetails, type PlanLimits, type PlanSource, type PlanUpgradeDetails, utcPeriod } from '@rejectradar/contracts';
import { type Database, lookupLog, org, subscription, usageCounter } from '@rejectradar/db';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';
import type { Tx } from '../database/tx';

type Executor = Database | Tx;
type Counter = 'bulk_rows' | 'api_calls';
type CounterColumn = typeof usageCounter.lookups | typeof usageCounter.bulkRows | typeof usageCounter.apiCalls;

/**
 * Subscription statuses that pay for the plan (spec §10.1); anything else is `free`. `past_due` keeps the plan while
 * Paddle retries a failed payment, so a team is not cut off mid-dunning (P7-D6).
 */
const PAID_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

const COUNTERS = {
  bulk_rows: { field: 'bulkRows', column: usageCounter.bulkRows, limit: (limits: PlanLimits) => limits.bulkRowsPerMonth },
  api_calls: { field: 'apiCalls', column: usageCounter.apiCalls, limit: (limits: PlanLimits) => limits.apiCallsPerMonth },
} as const;

/** Thrown inside a counting transaction to roll it back; the caller turns it into the `403` once the rollback is done. */
class LimitHit extends Error {}

const limitReached = (details: PlanLimitDetails) =>
  new AppError(HttpStatus.FORBIDDEN, 'PLAN_LIMIT_REACHED', 'Your plan allows no more of this. Upgrade to continue.', details);
const upgradeRequired = (details: PlanUpgradeDetails) =>
  new AppError(HttpStatus.FORBIDDEN, 'PLAN_UPGRADE_REQUIRED', 'Your plan does not include this. Upgrade to use it.', details);

/**
 * What an account's plan allows and how much of it is used this UTC month (spec §10.1, P5-D1/D2). Every method takes
 * the pool by default, or the caller's transaction so a limit check and the write it guards commit together.
 */
@Injectable()
export class EntitlementsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** `plan_override`, then a subscription that is `active`, `trialing` or `past_due`, otherwise `free`; `source` says which one decided. */
  async resolvePlan(orgId: string, executor: Executor = this.db): Promise<{ plan: PlanId; limits: PlanLimits; source: PlanSource }> {
    const [row] = await executor
      .select({ override: org.planOverride, plan: subscription.plan, status: subscription.status })
      .from(org)
      .leftJoin(subscription, eq(subscription.orgId, org.id))
      .where(eq(org.id, orgId));
    let plan: PlanId = 'free';
    let source: PlanSource = 'free';
    if (row?.override && isPlanId(row.override)) {
      plan = row.override;
      source = 'override';
    } else if (row?.plan && row.status && PAID_STATUSES.includes(row.status) && isPlanId(row.plan) && row.plan !== 'free') {
      plan = row.plan;
      source = 'subscription';
    }
    return { plan, limits: PLANS[plan], source };
  }

  /** Refuses the `used + 1`th watched item or member when the plan's limit is `used` already. */
  async assertCount(orgId: string, action: 'watchlist' | 'members', used: number, executor: Executor = this.db): Promise<void> {
    const { plan, limits } = await this.resolvePlan(orgId, executor);
    const limit = action === 'watchlist' ? limits.watchlistSize : limits.members;
    if (used + 1 > limit) throw limitReached({ action, plan, limit, used });
  }

  /** Refuses a feature the plan does not include. */
  async assertFeature(orgId: string, feature: 'pdf' | 'bulk' | 'api', executor: Executor = this.db): Promise<void> {
    const { plan, limits } = await this.resolvePlan(orgId, executor);
    const included = feature === 'pdf' ? limits.pdf : feature === 'bulk' ? limits.bulk : limits.apiCallsPerMonth > 0;
    if (!included) throw upgradeRequired({ feature, plan });
  }

  /**
   * Charges one lookup for opening `firmId` unless the account opened it this month (P5-D2). The log row decides
   * whether it is new; only a new one increments the counter, and only while the counter is below the limit. At the
   * limit the log row is rolled back, so the refused firm stays unopened.
   */
  async chargeLookup(
    orgId: string,
    firmId: number,
    executor: Executor = this.db,
  ): Promise<{ charged: boolean; used: number; limit: number }> {
    const { plan, limits } = await this.resolvePlan(orgId, executor);
    const limit = limits.lookupsPerMonth;
    const period = utcPeriod();
    try {
      // A transaction on the pool; a savepoint inside the caller's, so a refusal rolls back only this charge.
      return await (executor as Database).transaction(async (tx) => {
        const logged = await tx.insert(lookupLog).values({ orgId, firmId, period }).onConflictDoNothing().returning({ firmId: lookupLog.firmId });
        if (logged.length === 0) return { charged: false, used: await this.counterValue(tx, orgId, period, usageCounter.lookups), limit };
        // A fresh row is inserted without the where clause, so a plan with no lookups at all is refused up front.
        if (limit < 1) throw new LimitHit();
        const [counted] = await tx
          .insert(usageCounter)
          .values({ orgId, period, lookups: 1 })
          .onConflictDoUpdate({
            target: [usageCounter.orgId, usageCounter.period],
            set: { lookups: sql`${usageCounter.lookups} + 1` },
            setWhere: sql`${usageCounter.lookups} < ${limit}`,
          })
          .returning({ lookups: usageCounter.lookups });
        if (!counted) throw new LimitHit();
        return { charged: true, used: counted.lookups, limit };
      });
    } catch (error) {
      if (!(error instanceof LimitHit)) throw error;
      const used = await this.counterValue(executor, orgId, period, usageCounter.lookups);
      throw limitReached({ action: 'lookup', plan, limit, used });
    }
  }

  /** Adds `amount` to a monthly counter (P6 bulk rows, P8 API calls) unless that passes the limit; nothing is added then. */
  async consume(orgId: string, counter: Counter, amount: number, executor: Executor = this.db): Promise<{ used: number; limit: number }> {
    if (!Number.isInteger(amount) || amount < 1) throw new RangeError('The amount to consume must be a positive whole number.');
    const { plan, limits } = await this.resolvePlan(orgId, executor);
    const { field, column, limit: limitOf } = COUNTERS[counter];
    const limit = limitOf(limits);
    const period = utcPeriod();
    // A fresh row is inserted without the where clause, so an amount over the limit is refused before it gets there.
    if (amount <= limit) {
      const [row] = await executor
        .insert(usageCounter)
        .values({ orgId, period, [field]: amount })
        .onConflictDoUpdate({
          target: [usageCounter.orgId, usageCounter.period],
          set: { [field]: sql`${column} + ${amount}` },
          setWhere: sql`${column} + ${amount} <= ${limit}`,
        })
        .returning({ used: column });
      if (row) return { used: row.used, limit };
    }
    throw limitReached({ action: counter, plan, limit, used: await this.counterValue(executor, orgId, period, column) });
  }

  /** The first day notice search and dashboards reach (`YYYY-MM-DD`, UTC), or null for all history. */
  async historyFrom(orgId: string, executor: Executor = this.db): Promise<string | null> {
    const { limits } = await this.resolvePlan(orgId, executor);
    if (limits.noticeHistoryMonths === null) return null;
    const result = await executor.execute<{ from: string }>(
      sql`select to_char((now() at time zone 'utc')::date - make_interval(months => ${limits.noticeHistoryMonths}), 'YYYY-MM-DD') as "from"`,
    );
    return result.rows[0].from;
  }

  /** This UTC month's usage; zeros before anything is counted. */
  async usage(orgId: string, executor: Executor = this.db): Promise<{ period: string; lookups: number; bulkRows: number; apiCalls: number }> {
    const period = utcPeriod();
    const [row] = await executor
      .select({ lookups: usageCounter.lookups, bulkRows: usageCounter.bulkRows, apiCalls: usageCounter.apiCalls })
      .from(usageCounter)
      .where(and(eq(usageCounter.orgId, orgId), eq(usageCounter.period, period)));
    return { period, lookups: row?.lookups ?? 0, bulkRows: row?.bulkRows ?? 0, apiCalls: row?.apiCalls ?? 0 };
  }

  private async counterValue(executor: Executor, orgId: string, period: string, column: CounterColumn): Promise<number> {
    const [row] = await executor
      .select({ value: column })
      .from(usageCounter)
      .where(and(eq(usageCounter.orgId, orgId), eq(usageCounter.period, period)));
    return row?.value ?? 0;
  }
}
