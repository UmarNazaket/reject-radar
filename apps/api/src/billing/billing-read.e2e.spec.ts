import type { PlansResponse, SubscriptionResponse } from '@rejectradar/contracts';
import { org, subscription } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { joinByInvite, signUpVerified, startTestApp, type TestApp, type TestSession, testEnv } from '../testing/test-app';

describe('billing: plans and subscription', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_billing_read');
    fx = await seedReferenceData(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const account = () => signUpVerified(t, { email: `user${++n}@billing-read.test` });
  const read = async (session: TestSession) => (await session.get('/v1/billing/subscription').expect(200)).body as SubscriptionResponse;
  const prices = testEnv('postgres://unused');

  it('plans are public and priced', async () => {
    const res = await t.session().get('/v1/billing/plans').expect(200);
    const { plans } = res.body as PlansResponse;
    expect(plans.map((plan) => plan.id)).toEqual(['free', 'pro', 'business', 'enterprise']);
    const byId = Object.fromEntries(plans.map((plan) => [plan.id, plan]));
    expect(byId.pro).toMatchObject({
      name: 'Pro',
      monthlyPriceUsd: 39,
      yearlyPriceUsd: 390,
      prices: { month: prices.PADDLE_PRICE_PRO_MONTHLY, year: prices.PADDLE_PRICE_PRO_YEARLY },
    });
    expect(byId.pro.limits).toMatchObject({ lookupsPerMonth: 200, watchlistSize: 25, members: 3 });
    expect(byId.business).toMatchObject({
      monthlyPriceUsd: 149,
      yearlyPriceUsd: 1490,
      prices: { month: prices.PADDLE_PRICE_BUSINESS_MONTHLY, year: prices.PADDLE_PRICE_BUSINESS_YEARLY },
    });
    expect(byId.free.prices).toBeNull();
    expect(byId.enterprise.prices).toBeNull();
    expect(byId.enterprise.monthlyPriceUsd).toBeNull();
    // Exactly these fields: nothing internal rides along.
    expect(Object.keys(byId.free).sort()).toEqual(['id', 'limits', 'monthlyPriceUsd', 'name', 'prices', 'yearlyPriceUsd']);
  });

  it('a new account reads free', async () => {
    const { session } = await account();
    const sub = await read(session);
    expect(sub).toMatchObject({
      plan: 'free',
      source: 'free',
      status: null,
      interval: null,
      currentPeriodEnd: null,
      cancelAt: null,
      hasBillingAccount: false,
      canManage: true,
      limits: { lookupsPerMonth: 10 },
    });
    expect(sub.usage).toMatchObject({ lookups: 0, bulkRows: 0, apiCalls: 0, watchlist: 0, members: 1 });
    expect(sub.usage.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('a paid subscription', async () => {
    const { session, orgId } = await account();
    await t.db
      .update(subscription)
      .set({
        plan: 'pro',
        status: 'active',
        interval: 'month',
        paddleCustomerId: 'ctm_01billingread0000000000001',
        paddleSubscriptionId: 'sub_01billingread0000000000001',
        currentPeriodEnd: new Date('2030-01-15T00:00:00Z'),
        cancelAt: new Date('2030-01-15T00:00:00Z'),
      })
      .where(eq(subscription.orgId, orgId));
    expect(await read(session)).toMatchObject({
      plan: 'pro',
      source: 'subscription',
      status: 'active',
      interval: 'month',
      currentPeriodEnd: '2030-01-15T00:00:00.000Z',
      cancelAt: '2030-01-15T00:00:00.000Z',
      hasBillingAccount: true,
      limits: { lookupsPerMonth: 200 },
    });
  });

  it('a canceled subscription reads free but keeps the billing account', async () => {
    const { session, orgId } = await account();
    await t.db
      .update(subscription)
      .set({ plan: 'pro', status: 'canceled', interval: 'year', paddleCustomerId: 'ctm_01billingread0000000000002', paddleSubscriptionId: 'sub_01billingread0000000000002' })
      .where(eq(subscription.orgId, orgId));
    expect(await read(session)).toMatchObject({ plan: 'free', source: 'free', status: 'canceled', interval: 'year', hasBillingAccount: true });
  });

  it('override wins and says so', async () => {
    const { session, orgId } = await account();
    await t.db.update(org).set({ planOverride: 'enterprise' }).where(eq(org.id, orgId));
    expect(await read(session)).toMatchObject({ plan: 'enterprise', source: 'override', hasBillingAccount: false });
  });

  it('usage counts', async () => {
    const { session } = await account();
    await session.get(`/v1/firms/${fx.firms.zarfeen}`).expect(200);
    await session.post('/v1/watchlist').send({ kind: 'topic', originCountry: 'LK' }).expect(201);
    await session.post('/v1/watchlist').send({ kind: 'topic', originCountry: 'BD' }).expect(201);
    expect((await read(session)).usage).toMatchObject({ lookups: 1, watchlist: 2, members: 1 });
  });

  it('canManage only for owners', async () => {
    const { session: owner, orgId } = await account();
    await t.db.update(org).set({ planOverride: 'pro' }).where(eq(org.id, orgId));
    const member = await joinByInvite(t, owner, { email: `member${n}@billing-read.test`, role: 'member' });
    expect((await read(owner)).canManage).toBe(true);
    const seen = await read(member.session);
    expect(seen.canManage).toBe(false);
    expect(seen.usage.members).toBe(2);
  });

  it('the subscription needs a session', async () => {
    await t.session().get('/v1/billing/subscription').expect(401);
  });
});
