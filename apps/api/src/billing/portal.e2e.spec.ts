import type { PortalResponse } from '@rejectradar/contracts';
import { subscription } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { FakePaddleGateway } from '../testing/paddle-fixtures';
import { joinByInvite, setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('billing: customer portal', () => {
  let t: TestApp;
  const gateway = new FakePaddleGateway();
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_billing_portal', { paddleGateway: gateway });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
    gateway.portalCalls.length = 0;
  });

  const account = () => signUpVerified(t, { email: `owner${++n}@billing-portal.test` });
  const portal = (session: TestSession) => session.post('/v1/billing/portal');
  const setSubscription = (orgId: string, fields: Partial<typeof subscription.$inferInsert>) => t.db.update(subscription).set(fields).where(eq(subscription.orgId, orgId));

  it('an owner gets a portal url', async () => {
    const { session, orgId } = await account();
    await setSubscription(orgId, { plan: 'pro', status: 'active', interval: 'month', paddleCustomerId: `ctm_portal_${orgId}`, paddleSubscriptionId: `sub_portal_${orgId}` });
    const res = await portal(session).expect(200);
    expect(res.body as PortalResponse).toEqual({ url: `https://sandbox-customer-portal.paddle.com/fake/ctm_portal_${orgId}` });
    expect(gateway.portalCalls).toEqual([{ customerId: `ctm_portal_${orgId}`, subscriptionIds: [`sub_portal_${orgId}`] }]);
  });

  it('a canceled subscription still opens the portal', async () => {
    const { session, orgId } = await account();
    await setSubscription(orgId, { plan: 'pro', status: 'canceled', interval: 'month', paddleCustomerId: `ctm_portal_${orgId}`, paddleSubscriptionId: `sub_portal_${orgId}` });
    await portal(session).expect(200);
    expect(gateway.portalCalls).toEqual([{ customerId: `ctm_portal_${orgId}`, subscriptionIds: [] }]);
  });

  it('a customer without a subscription opens the portal with no subscriptions', async () => {
    const { session, orgId } = await account();
    await setSubscription(orgId, { paddleCustomerId: `ctm_portal_${orgId}` });
    await portal(session).expect(200);
    expect(gateway.portalCalls).toEqual([{ customerId: `ctm_portal_${orgId}`, subscriptionIds: [] }]);
  });

  it('no customer', async () => {
    const { session } = await account();
    const res = await portal(session).expect(409);
    expect(res.body).toMatchObject({ code: 'NO_BILLING_ACCOUNT' });
    expect(gateway.portalCalls).toEqual([]);
  });

  it('owners only', async () => {
    const { session: owner, orgId } = await account();
    await setPlan(t, orgId, 'business');
    await setSubscription(orgId, { paddleCustomerId: `ctm_portal_${orgId}` });
    const member = await joinByInvite(t, owner, { email: `member${n}@billing-portal.test`, role: 'member' });
    const admin = await joinByInvite(t, owner, { email: `admin${n}@billing-portal.test`, role: 'admin' });
    for (const { session } of [member, admin]) {
      const res = await portal(session).expect(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(gateway.portalCalls).toEqual([]);
  });

  it('needs a session', async () => {
    await t.session().post('/v1/billing/portal').set('X-RejectRadar-CSRF', '1').expect(401);
  });

  it('needs the CSRF header', async () => {
    const { session } = await account();
    const res = await request(t.app.getHttpServer()).post('/v1/billing/portal').set('Cookie', `rr_at=${session.cookie('rr_at')}`).expect(403);
    expect(res.body).toMatchObject({ code: 'CSRF_MISSING' });
  });
});
