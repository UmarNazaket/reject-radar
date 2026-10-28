import type { CheckoutResponse } from '@rejectradar/contracts';
import { subscription } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { joinByInvite, setPlan, signUpVerified, startTestApp, type TestApp, type TestSession, testEnv } from '../testing/test-app';

describe('billing: checkout', () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_billing_checkout');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const env = testEnv('postgres://unused');
  const account = () => signUpVerified(t, { email: `owner${++n}@billing-checkout.test` });
  const checkout = (session: TestSession, body: object = { plan: 'pro', interval: 'month' }) => session.post('/v1/billing/checkout').send(body);
  const subscribe = (orgId: string, status: 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled') =>
    t.db
      .update(subscription)
      .set({ plan: 'pro', status, interval: 'month', paddleCustomerId: `ctm_checkout_${orgId}`, paddleSubscriptionId: `sub_checkout_${orgId}` })
      .where(eq(subscription.orgId, orgId));

  it('an owner gets the checkout details', async () => {
    const { session, orgId } = await account();
    const res = await checkout(session, { plan: 'business', interval: 'year' }).expect(200);
    expect(res.body as CheckoutResponse).toEqual({
      priceId: env.PADDLE_PRICE_BUSINESS_YEARLY,
      customData: { orgId },
      customerEmail: `owner${n}@billing-checkout.test`,
      clientToken: env.PADDLE_CLIENT_TOKEN,
      environment: 'sandbox',
      successUrl: 'http://localhost:4200/app/settings/billing?checkout=success',
    });
  });

  it('prices follow the plan and interval', async () => {
    const { session } = await account();
    const price = async (plan: string, interval: string) => ((await checkout(session, { plan, interval }).expect(200)).body as CheckoutResponse).priceId;
    expect(await price('pro', 'month')).toBe(env.PADDLE_PRICE_PRO_MONTHLY);
    expect(await price('pro', 'year')).toBe(env.PADDLE_PRICE_PRO_YEARLY);
    expect(await price('business', 'month')).toBe(env.PADDLE_PRICE_BUSINESS_MONTHLY);
  });

  it('members and admins are refused', async () => {
    const { session: owner, orgId } = await account();
    await setPlan(t, orgId, 'business');
    const member = await joinByInvite(t, owner, { email: `member${n}@billing-checkout.test`, role: 'member' });
    const admin = await joinByInvite(t, owner, { email: `admin${n}@billing-checkout.test`, role: 'admin' });
    for (const { session } of [member, admin]) {
      const res = await checkout(session).expect(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('needs a verified email', async () => {
    const session = t.session();
    await session
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: `unverified${++n}@billing-checkout.test`, password: 'zarfeen-rice-2026', companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await session.post('/v1/auth/login').send({ email: `unverified${n}@billing-checkout.test`, password: 'zarfeen-rice-2026' }).expect(200);
    const res = await checkout(session).expect(403);
    expect(res.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it.each(['active', 'trialing', 'past_due'] as const)('is refused while the subscription is %s', async (status) => {
    const { session, orgId } = await account();
    await subscribe(orgId, status);
    const res = await checkout(session).expect(409);
    expect(res.body).toMatchObject({ code: 'ALREADY_SUBSCRIBED' });
  });

  it.each(['canceled', 'paused'] as const)('is allowed once the subscription is %s', async (status) => {
    const { session, orgId } = await account();
    await subscribe(orgId, status);
    await checkout(session).expect(200);
  });

  it('a new account with no Paddle subscription is allowed', async () => {
    const { session } = await account();
    await checkout(session).expect(200);
  });

  it('an override does not block', async () => {
    const { session, orgId } = await account();
    await setPlan(t, orgId, 'business');
    await checkout(session).expect(200);
  });

  it.each([{ plan: 'enterprise', interval: 'month' }, { plan: 'free', interval: 'month' }, { plan: 'pro', interval: 'week' }, { plan: 'pro' }, {}])(
    'rejects %j',
    async (body) => {
      const { session } = await account();
      const res = await checkout(session, body).expect(400);
      expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
    },
  );

  it('needs a session', async () => {
    await t.session().post('/v1/billing/checkout').set('X-RejectRadar-CSRF', '1').send({ plan: 'pro', interval: 'month' }).expect(401);
  });

  it('needs the CSRF header', async () => {
    const { session } = await account();
    const res = await request(t.app.getHttpServer())
      .post('/v1/billing/checkout')
      .set('Cookie', `rr_at=${session.cookie('rr_at')}`)
      .send({ plan: 'pro', interval: 'month' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'CSRF_MISSING' });
  });
});
