import { PLANS, type PlanId, planLimitDetailsSchema, planUpgradeDetailsSchema, type SubscriptionStatus, utcPeriod } from '@rejectradar/contracts';
import { subscription, usageCounter } from '@rejectradar/db';
import { insertFirm } from '@rejectradar/entities';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { setPlan, signUpVerified, startTestApp, type TestApp } from '../testing/test-app';
import { EntitlementsService } from './entitlements.service';

describe('entitlements', () => {
  let t: TestApp;
  let service: EntitlementsService;
  let orgId: string;
  let firms: number[];

  beforeAll(async () => {
    t = await startTestApp('api_entitlements');
    service = t.app.get(EntitlementsService);
    firms = [];
    for (let i = 1; i <= 12; i++) firms.push(await insertFirm(t.db, { displayName: `Entitlement Test Firm ${i}` }));
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    await t.db.execute(sql`truncate app_user, org, email_delivery cascade`);
    ({ orgId } = await signUpVerified(t, { email: 'owner@example.com' }));
  });

  const caught = async (promise: Promise<unknown>): Promise<AppError> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      return error as AppError;
    }
    throw new Error('Expected the call to be refused');
  };
  /** Sign-up leaves a free, active subscription behind; this is the account moving to another one. */
  const subscribe = (plan: PlanId, status: SubscriptionStatus) => t.db.update(subscription).set({ plan, status }).where(eq(subscription.orgId, orgId));
  const logRows = async () => (await t.db.execute<{ n: number }>(sql`select count(*)::int as n from lookup_log where org_id = ${orgId}`)).rows[0].n;

  it('a new account is on free', async () => {
    const { plan, limits } = await service.resolvePlan(orgId);
    expect(plan).toBe('free');
    expect(limits).toEqual(PLANS.free);
    expect(limits.lookupsPerMonth).toBe(10);
  });

  it('a subscription that is active, trialing or past_due sets the plan', async () => {
    await subscribe('pro', 'trialing');
    expect((await service.resolvePlan(orgId)).plan).toBe('pro');
    await subscribe('business', 'active');
    expect((await service.resolvePlan(orgId)).plan).toBe('business');
    // P7-D6: a failed payment keeps the plan while Paddle retries it.
    await subscribe('business', 'past_due');
    expect((await service.resolvePlan(orgId)).plan).toBe('business');
    await subscribe('business', 'paused');
    expect((await service.resolvePlan(orgId)).plan).toBe('free');
  });

  it('plan_override wins over the subscription', async () => {
    await subscribe('pro', 'active');
    await setPlan(t, orgId, 'business');
    expect((await service.resolvePlan(orgId)).plan).toBe('business');
  });

  it('a canceled subscription counts as free', async () => {
    await subscribe('pro', 'canceled');
    expect((await service.resolvePlan(orgId)).plan).toBe('free');
  });

  it('the same firm twice in a month is charged once', async () => {
    expect(await service.chargeLookup(orgId, firms[0])).toEqual({ charged: true, used: 1, limit: 10 });
    expect(await service.chargeLookup(orgId, firms[0])).toEqual({ charged: false, used: 1, limit: 10 });
    expect((await service.usage(orgId)).lookups).toBe(1);
  });

  it('the eleventh firm is refused on free', async () => {
    for (let i = 0; i < 10; i++) await service.chargeLookup(orgId, firms[i]);
    const error = await caught(service.chargeLookup(orgId, firms[10]));
    expect(error.code).toBe('PLAN_LIMIT_REACHED');
    expect(error.getStatus()).toBe(403);
    expect(planLimitDetailsSchema.parse(error.details)).toEqual({ action: 'lookup', plan: 'free', limit: 10, used: 10 });
    expect(await logRows()).toBe(10);
    expect((await service.usage(orgId)).lookups).toBe(10);
    // A firm already opened this month is still free at the limit.
    expect(await service.chargeLookup(orgId, firms[3])).toEqual({ charged: false, used: 10, limit: 10 });
  });

  it('two views of the last lookup at once charge one', async () => {
    for (let i = 0; i < 9; i++) await service.chargeLookup(orgId, firms[i]);
    const results = await Promise.allSettled([service.chargeLookup(orgId, firms[9]), service.chargeLookup(orgId, firms[10])]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(((refused[0] as PromiseRejectedResult).reason as AppError).code).toBe('PLAN_LIMIT_REACHED');
    expect((await service.usage(orgId)).lookups).toBe(10);
    expect(await logRows()).toBe(10);
  });

  it('a lookup inside the callers transaction rolls back with it', async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await service.chargeLookup(orgId, firms[0], tx);
        throw new Error('the caller failed');
      }),
    ).rejects.toThrow('the caller failed');
    expect(await logRows()).toBe(0);
    expect((await service.usage(orgId)).lookups).toBe(0);

    // A refusal inside the callers transaction leaves the caller able to carry on.
    await t.db.transaction(async (tx) => {
      for (let i = 0; i < 10; i++) await service.chargeLookup(orgId, firms[i], tx);
      expect((await caught(service.chargeLookup(orgId, firms[10], tx))).code).toBe('PLAN_LIMIT_REACHED');
      expect(await service.chargeLookup(orgId, firms[0], tx)).toMatchObject({ charged: false, used: 10 });
    });
    expect((await service.usage(orgId)).lookups).toBe(10);
    expect(await logRows()).toBe(10);
  });

  it('a new month starts at zero', async () => {
    const now = new Date();
    const lastMonth = utcPeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)));
    await t.db.insert(usageCounter).values({ orgId, period: lastMonth, lookups: 10, bulkRows: 7, apiCalls: 9 });
    await t.db.execute(sql`insert into lookup_log (org_id, firm_id, period) values (${orgId}, ${firms[0]}, ${lastMonth})`);

    expect(await service.usage(orgId)).toEqual({ period: utcPeriod(), lookups: 0, bulkRows: 0, apiCalls: 0 });
    // Last months log row does not make this months view of the same firm free.
    expect(await service.chargeLookup(orgId, firms[0])).toEqual({ charged: true, used: 1, limit: 10 });
  });

  it('counts per account', async () => {
    const other = await signUpVerified(t, { email: 'other@example.com' });
    await service.chargeLookup(orgId, firms[0]);
    expect(await service.chargeLookup(other.orgId, firms[0])).toMatchObject({ charged: true, used: 1 });
  });

  it('a higher plan has a higher limit', async () => {
    await setPlan(t, orgId, 'pro');
    for (let i = 0; i < 11; i++) await service.chargeLookup(orgId, firms[i]);
    expect(await service.chargeLookup(orgId, firms[11])).toEqual({ charged: true, used: 12, limit: 200 });
  });

  it('historyFrom is current_date - 12 months for free and null for pro', async () => {
    const expected = (
      await t.db.execute<{ d: string }>(sql`select to_char((now() at time zone 'utc')::date - interval '12 months', 'YYYY-MM-DD') as d`)
    ).rows[0].d;
    expect(await service.historyFrom(orgId)).toBe(expected);
    await setPlan(t, orgId, 'pro');
    expect(await service.historyFrom(orgId)).toBeNull();
  });

  it('assertFeature refuses pdf on free and allows it on pro', async () => {
    const error = await caught(service.assertFeature(orgId, 'pdf'));
    expect(error.code).toBe('PLAN_UPGRADE_REQUIRED');
    expect(error.getStatus()).toBe(403);
    expect(planUpgradeDetailsSchema.parse(error.details)).toEqual({ feature: 'pdf', plan: 'free' });

    await setPlan(t, orgId, 'pro');
    await service.assertFeature(orgId, 'pdf');
    expect((await caught(service.assertFeature(orgId, 'bulk'))).details).toEqual({ feature: 'bulk', plan: 'pro' });
    expect((await caught(service.assertFeature(orgId, 'api'))).details).toEqual({ feature: 'api', plan: 'pro' });
    await setPlan(t, orgId, 'business');
    await service.assertFeature(orgId, 'bulk');
    await service.assertFeature(orgId, 'api');
  });

  it('assertCount refuses when used + 1 passes the limit', async () => {
    await service.assertCount(orgId, 'watchlist', 2);
    const error = await caught(service.assertCount(orgId, 'watchlist', 3));
    expect(error.code).toBe('PLAN_LIMIT_REACHED');
    expect(error.details).toEqual({ action: 'watchlist', plan: 'free', limit: 3, used: 3 });

    expect((await caught(service.assertCount(orgId, 'members', 1))).details).toEqual({ action: 'members', plan: 'free', limit: 1, used: 1 });
    await service.assertCount(orgId, 'members', 0);
  });

  it('consume counts bulk rows and api calls up to the limit', async () => {
    await setPlan(t, orgId, 'business');
    expect(await service.consume(orgId, 'bulk_rows', 4000)).toEqual({ used: 4000, limit: 5000 });
    expect(await service.consume(orgId, 'bulk_rows', 1000)).toEqual({ used: 5000, limit: 5000 });
    const error = await caught(service.consume(orgId, 'bulk_rows', 1));
    expect(error.details).toEqual({ action: 'bulk_rows', plan: 'business', limit: 5000, used: 5000 });
    expect(await service.consume(orgId, 'api_calls', 1)).toEqual({ used: 1, limit: 10000 });
    expect(await service.usage(orgId)).toEqual({ period: utcPeriod(), lookups: 0, bulkRows: 5000, apiCalls: 1 });
  });

  it('consume refuses an amount over the limit in a fresh month, and anything on a plan with none', async () => {
    await setPlan(t, orgId, 'business');
    expect((await caught(service.consume(orgId, 'bulk_rows', 5001))).details).toMatchObject({ used: 0 });
    expect(await service.usage(orgId)).toMatchObject({ bulkRows: 0 });

    await setPlan(t, orgId, 'free');
    expect((await caught(service.consume(orgId, 'api_calls', 1))).code).toBe('PLAN_LIMIT_REACHED');
  });

  it('parallel consumption never passes the limit', async () => {
    await setPlan(t, orgId, 'business');
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.consume(orgId, 'bulk_rows', 1000)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect((await service.usage(orgId)).bulkRows).toBe(5000);
  });
});
