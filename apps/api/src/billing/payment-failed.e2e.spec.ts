import { appUser as appUserTable, emailDelivery, membership, subscription } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import { translate } from '@rejectradar/i18n';
import type { Locale } from '@rejectradar/contracts';
import { paddleEvent, paddleId, paddleSubscription, postWebhook } from '../testing/paddle-fixtures';
import { joinByInvite, setPlan, signUpVerified, startTestApp, type TestApp, testEnv } from '../testing/test-app';

describe('billing: the payment-failed email', () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_payment_failed');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    await t.db.execute(sql`truncate email_delivery`);
    t.mail.sent.length = 0;
  });

  const env = testEnv('postgres://unused');
  const PRO_MONTH = env.PADDLE_PRICE_PRO_MONTHLY;
  const BILLING_LINK = `${env.APP_ORIGIN}/app/settings/billing`;

  /** An account on an active Paddle subscription, with an English owner. */
  async function subscribed() {
    const owner = await signUpVerified(t, { email: `owner${++n}@payment-failed.test`, company: 'Zarfeen Rice Mills' });
    const subscriptionId = paddleId('sub');
    const customerId = paddleId('ctm');
    const fields = { id: subscriptionId, customerId, orgId: owner.orgId, priceId: PRO_MONTH };
    await postWebhook(t, paddleEvent('subscription.created', paddleSubscription({ ...fields, status: 'active' }), { occurred_at: '2030-01-01T10:00:00.000000Z' })).expect(200);
    t.mail.sent.length = 0;
    return { ...owner, fields };
  }

  /** Makes `email` a second owner of the account (an invited admin, then promoted) in `locale`. */
  async function addOwner(account: Awaited<ReturnType<typeof subscribed>>, email: string, locale: Locale) {
    await setPlan(t, account.orgId, 'business');
    const joined = await joinByInvite(t, account.session, { email, role: 'admin', locale });
    await t.db.update(membership).set({ role: 'owner' }).where(eq(membership.userId, joined.userId));
    t.mail.sent.length = 0;
    return joined;
  }

  const kinds = async () => (await t.db.select({ kind: emailDelivery.kind }).from(emailDelivery)).map((r) => r.kind);
  const pastDue = (fields: Parameters<typeof paddleSubscription>[0], at: string, type = 'subscription.updated') =>
    postWebhook(t, paddleEvent(type, paddleSubscription({ ...fields, status: 'past_due' }), { occurred_at: at }));

  it('a move into past_due emails each verified owner in their language', async () => {
    const account = await subscribed();
    const ownerEmail = (await t.db.select({ email: appUserTable.email }).from(appUserTable).where(eq(appUserTable.id, account.userId)))[0].email;
    const urOwner = await addOwner(account, 'urdu-owner@payment-failed.test', 'ur');
    const admin = await joinByInvite(t, account.session, { email: 'admin@payment-failed.test', role: 'admin' });
    expect(admin.userId).toBeDefined();
    t.mail.sent.length = 0;

    await pastDue(account.fields, '2030-01-02T10:00:00.000000Z').expect(200);

    expect(t.mail.sent).toHaveLength(2);
    const en = t.mail.lastTo(ownerEmail);
    expect(en.subject).toBe(translate('en', 'email.paymentFailed.subject'));
    expect(en.html).toContain('dir="ltr"');
    expect(t.mail.linkIn(en).href).toBe(BILLING_LINK);
    const ur = t.mail.lastTo('urdu-owner@payment-failed.test');
    expect(ur.subject).toBe(translate('ur', 'email.paymentFailed.subject'));
    expect(ur.html).toContain('dir="rtl"');
    expect(t.mail.linkIn(ur).href).toBe(BILLING_LINK);
    expect(() => t.mail.lastTo('admin@payment-failed.test')).toThrow();
    expect(urOwner.userId).toBeDefined();
    expect(await kinds()).toEqual(expect.arrayContaining(['payment_failed']));
    expect((await kinds()).filter((k) => k === 'payment_failed')).toHaveLength(2);
  });

  it('subscription.past_due sends the same email', async () => {
    const account = await subscribed();
    await pastDue(account.fields, '2030-01-02T10:00:00.000000Z', 'subscription.past_due').expect(200);
    expect(t.mail.sent).toHaveLength(1);
    expect((await kinds()).filter((k) => k === 'payment_failed')).toHaveLength(1);
    expect((await t.db.select().from(subscription).where(eq(subscription.orgId, account.orgId)))[0].status).toBe('past_due');
  });

  it('a repeated past_due sends nothing', async () => {
    const account = await subscribed();
    await pastDue(account.fields, '2030-01-02T10:00:00.000000Z').expect(200);
    expect(t.mail.sent).toHaveLength(1);
    await pastDue(account.fields, '2030-01-03T10:00:00.000000Z').expect(200);
    expect(t.mail.sent).toHaveLength(1);
    expect((await kinds()).filter((k) => k === 'payment_failed')).toHaveLength(1);
  });

  it('the email cap never fails the webhook', async () => {
    const account = await subscribed();
    await t.db.execute(
      sql`insert into email_delivery (id, to_email, kind, status, created_at)
          select gen_random_uuid(), 'seed@example.com', 'verify', 'sent', now() from generate_series(1, 100)`,
    );
    await pastDue(account.fields, '2030-01-02T10:00:00.000000Z').expect(200);
    expect(t.mail.sent).toHaveLength(0);
    expect((await t.db.select().from(subscription).where(eq(subscription.orgId, account.orgId)))[0].status).toBe('past_due');
  });

  it('a failing transport never fails the webhook', async () => {
    const account = await subscribed();
    t.mail.failNext(new Error('provider down'));
    await pastDue(account.fields, '2030-01-02T10:00:00.000000Z').expect(200);
    expect((await t.db.select().from(subscription).where(eq(subscription.orgId, account.orgId)))[0].status).toBe('past_due');
  });

  it('an unverified owner gets nothing', async () => {
    const account = await subscribed();
    const second = await addOwner(account, 'unverified@payment-failed.test', 'en');
    await t.db.update(appUserTable).set({ emailVerifiedAt: null }).where(eq(appUserTable.id, second.userId));
    await pastDue(account.fields, '2030-01-02T10:00:00.000000Z').expect(200);
    expect(t.mail.sent).toHaveLength(1);
    expect(() => t.mail.lastTo('unverified@payment-failed.test')).toThrow();
  });
});
