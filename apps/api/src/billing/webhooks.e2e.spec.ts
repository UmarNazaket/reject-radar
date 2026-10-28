import { Logger } from '@nestjs/common';
import type { SubscriptionResponse } from '@rejectradar/contracts';
import { paddleEvent as paddleEventTable, subscription } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { type PaddleEventEnvelope, paddleEvent, paddleId, paddleSubscription, postWebhook } from '../testing/paddle-fixtures';
import { signUpVerified, startTestApp, type TestApp, type TestSession, testEnv } from '../testing/test-app';
import { signPaddlePayload } from './paddle/signature';
import { PaddleWebhookService } from './paddle-webhook.service';

describe('billing: Paddle webhooks', () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_paddle_webhooks');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const env = testEnv('postgres://unused');
  const PRO_MONTH = env.PADDLE_PRICE_PRO_MONTHLY;
  const PRO_YEAR = env.PADDLE_PRICE_PRO_YEARLY;
  const BUSINESS_MONTH = env.PADDLE_PRICE_BUSINESS_MONTHLY;
  const account = () => signUpVerified(t, { email: `owner${++n}@paddle-webhooks.test` });
  const row = async (orgId: string) => (await t.db.select().from(subscription).where(eq(subscription.orgId, orgId)))[0];
  const eventRows = (eventId: string) => t.db.select().from(paddleEventTable).where(eq(paddleEventTable.eventId, eventId));
  const read = async (session: TestSession) => (await session.get('/v1/billing/subscription').expect(200)).body as SubscriptionResponse;
  const deliver = async (event: PaddleEventEnvelope) => {
    const res = await postWebhook(t, event).expect(200);
    expect(res.body).toEqual({ received: true });
  };
  /** True when the stored `paddle_occurred_at` is exactly `at`, compared by Postgres at microsecond precision. */
  const occurredAtIs = async (orgId: string, at: string) => {
    const result = await t.db.execute<{ exact: boolean }>(sql`select paddle_occurred_at = ${at}::timestamptz as exact from subscription where org_id = ${orgId}`);
    return result.rows[0].exact;
  };
  /** Collects what `receive()` returned for every delivery made while it runs. */
  const spyOnReceive = () => {
    const spy = jest.spyOn(t.app.get(PaddleWebhookService), 'receive');
    return async () => Promise.all(spy.mock.results.map((result) => result.value as ReturnType<PaddleWebhookService['receive']>));
  };

  it('rejects a bad signature', async () => {
    const { orgId } = await account();
    const before = await row(orgId);
    const event = paddleEvent('subscription.created', paddleSubscription({ orgId, priceId: PRO_MONTH }));
    const raw = JSON.stringify(event);
    const now = Math.floor(Date.now() / 1000);
    const header = signPaddlePayload(Buffer.from(raw), env.PADDLE_WEBHOOK_SECRET, now);
    const post = () => request(t.app.getHttpServer()).post('/v1/webhooks/paddle');

    // Built one at a time: supertest starts listening when a request is created and stops when it ends.
    const attempts = [
      () => post().set('Content-Type', 'application/json').set('Paddle-Signature', header).send(raw.replace('"active"', '"paused"')),
      () => postWebhook(t, event, { secret: 'not-the-webhook-secret' }),
      () => postWebhook(t, event, { ts: now - 120 }),
      () => post().set('Content-Type', 'application/json').send(raw),
      // No JSON body parser runs for text/plain, so there is no raw body to check the signature against.
      () => post().set('Content-Type', 'text/plain').set('Paddle-Signature', header).send(raw),
    ];
    for (const attempt of attempts) {
      const res = await attempt().expect(401);
      expect(res.body).toMatchObject({ code: 'INVALID_SIGNATURE' });
    }
    expect(await t.db.select().from(paddleEventTable)).toEqual([]);
    expect(await row(orgId)).toEqual(before);
  });

  it('needs no session and no CSRF header', async () => {
    const event = paddleEvent('customer.updated', { id: paddleId('ctm') });
    // postWebhook sends no cookie and no X-RejectRadar-CSRF header.
    const res = await postWebhook(t, event).expect(200);
    expect(res.body).toEqual({ received: true });
    expect(await eventRows(event.event_id)).toHaveLength(1);
  });

  it('subscription.created links the account', async () => {
    const { session, orgId } = await account();
    const subId = paddleId('sub');
    const customerId = paddleId('ctm');
    const occurredAt = '2030-01-15T10:00:00.621022Z';
    const event = paddleEvent(
      'subscription.created',
      paddleSubscription({ id: subId, customerId, orgId, priceId: PRO_MONTH, status: 'active', periodEndsAt: '2030-02-15T10:00:00.123456Z' }),
      { occurred_at: occurredAt },
    );
    await deliver(event);

    expect(await row(orgId)).toMatchObject({
      plan: 'pro',
      interval: 'month',
      status: 'active',
      paddleSubscriptionId: subId,
      paddleCustomerId: customerId,
      currentPeriodEnd: new Date('2030-02-15T10:00:00.123Z'),
      cancelAt: null,
    });
    expect(await occurredAtIs(orgId, occurredAt)).toBe(true);

    const [stored] = await eventRows(event.event_id);
    expect(stored).toMatchObject({ type: 'subscription.created', payload: event });
    expect(stored.processedAt).toBeInstanceOf(Date);

    expect(await read(session)).toMatchObject({ plan: 'pro', source: 'subscription', status: 'active', interval: 'month', hasBillingAccount: true });
  });

  it('a duplicate is not reprocessed', async () => {
    const { orgId } = await account();
    const event = paddleEvent('subscription.created', paddleSubscription({ orgId, priceId: PRO_MONTH }));
    await deliver(event);
    expect((await row(orgId)).plan).toBe('pro');

    await t.db.update(subscription).set({ plan: 'free' }).where(eq(subscription.orgId, orgId));
    await deliver(event);
    expect((await row(orgId)).plan).toBe('free');
    expect(await eventRows(event.event_id)).toHaveLength(1);

    // Two deliveries of a new event at the same moment: one is applied, the other finds the row and changes nothing.
    const { orgId: other } = await account();
    const simultaneous = paddleEvent('subscription.created', paddleSubscription({ orgId: other, priceId: BUSINESS_MONTH }));
    const results = spyOnReceive();
    const responses = await Promise.all([postWebhook(t, simultaneous), postWebhook(t, simultaneous)]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    expect((await results()).map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(await eventRows(simultaneous.event_id)).toHaveLength(1);
    expect((await row(other)).plan).toBe('business');
  });

  it('older events are not applied', async () => {
    const { orgId } = await account();
    const id = paddleId('sub');
    const customerId = paddleId('ctm');
    const update = (priceId: string, at: string) =>
      paddleEvent('subscription.updated', paddleSubscription({ id, customerId, orgId, priceId }), { occurred_at: at });

    const business = update(BUSINESS_MONTH, '2030-01-15T10:05:00.000002Z');
    const pro = update(PRO_MONTH, '2030-01-15T10:00:00.000000Z');
    await deliver(business);
    await deliver(pro);
    expect((await row(orgId)).plan).toBe('business');
    for (const event of [business, pro]) expect((await eventRows(event.event_id))[0].processedAt).toBeInstanceOf(Date);

    // Microseconds count: one microsecond earlier is older, one later is newer.
    await deliver(update(PRO_MONTH, '2030-01-15T10:05:00.000001Z'));
    expect((await row(orgId)).plan).toBe('business');
    await deliver(update(PRO_YEAR, '2030-01-15T10:05:00.000003Z'));
    expect(await row(orgId)).toMatchObject({ plan: 'pro', interval: 'year' });
    expect(await occurredAtIs(orgId, '2030-01-15T10:05:00.000003Z')).toBe(true);
  });

  it('an update before its create', async () => {
    const { session, orgId } = await account();
    const id = paddleId('sub');
    const customerId = paddleId('ctm');
    const data = paddleSubscription({ id, customerId, orgId, priceId: PRO_MONTH });
    await deliver(paddleEvent('subscription.updated', data, { occurred_at: '2030-01-15T10:00:05.000000Z' }));
    await deliver(paddleEvent('subscription.created', data, { occurred_at: '2030-01-15T10:00:00.000000Z' }));
    expect(await row(orgId)).toMatchObject({ plan: 'pro', status: 'active', paddleSubscriptionId: id, paddleCustomerId: customerId });
    expect(await occurredAtIs(orgId, '2030-01-15T10:00:05Z')).toBe(true);
    expect((await read(session)).plan).toBe('pro');
  });

  it('cancellation', async () => {
    const { session, orgId } = await account();
    const id = paddleId('sub');
    const customerId = paddleId('ctm');
    const fields = { id, customerId, orgId, priceId: PRO_MONTH };
    await deliver(paddleEvent('subscription.created', paddleSubscription(fields), { occurred_at: '2030-01-15T10:00:00Z' }));

    const effectiveAt = '2030-02-15T10:00:00.123456Z';
    await deliver(
      paddleEvent('subscription.updated', paddleSubscription({ ...fields, scheduledChange: { action: 'cancel', effective_at: effectiveAt } }), {
        occurred_at: '2030-01-20T10:00:00Z',
      }),
    );
    expect(await row(orgId)).toMatchObject({ status: 'active', cancelAt: new Date('2030-02-15T10:00:00.123Z') });
    expect(await read(session)).toMatchObject({ plan: 'pro', status: 'active', cancelAt: '2030-02-15T10:00:00.123Z' });

    await deliver(
      paddleEvent('subscription.canceled', paddleSubscription({ ...fields, status: 'canceled', periodEndsAt: null }), { occurred_at: '2030-02-15T10:00:01Z' }),
    );
    expect(await row(orgId)).toMatchObject({ status: 'canceled', plan: 'pro', paddleSubscriptionId: id });
    expect(await read(session)).toMatchObject({ plan: 'free', source: 'free', status: 'canceled', hasBillingAccount: true });
  });

  it('past_due keeps paid limits', async () => {
    const { session, orgId } = await account();
    const fields = { id: paddleId('sub'), customerId: paddleId('ctm'), orgId, priceId: PRO_MONTH };
    await deliver(paddleEvent('subscription.created', paddleSubscription(fields), { occurred_at: '2030-01-15T10:00:00Z' }));

    const results = spyOnReceive();
    await deliver(paddleEvent('subscription.past_due', paddleSubscription({ ...fields, status: 'past_due' }), { occurred_at: '2030-02-15T10:00:00Z' }));
    expect(await read(session)).toMatchObject({ plan: 'pro', source: 'subscription', status: 'past_due', limits: { lookupsPerMonth: 200 } });

    // Only the move into past_due is reported (Task 6 emails the owners); a repeated past_due is not.
    await deliver(paddleEvent('subscription.updated', paddleSubscription({ ...fields, status: 'past_due' }), { occurred_at: '2030-02-16T10:00:00Z' }));
    expect(await results()).toEqual([
      { duplicate: false, pastDueOrgIds: [orgId] },
      { duplicate: false, pastDueOrgIds: [] },
    ]);
  });

  it('transaction.completed fills a missing customer', async () => {
    const { orgId } = await account();
    const customerId = paddleId('ctm');
    const transaction = (customer: string) =>
      paddleEvent('transaction.completed', { id: paddleId('txn'), status: 'completed', customer_id: customer, subscription_id: paddleId('sub'), custom_data: { orgId } });
    await deliver(transaction(customerId));
    expect(await row(orgId)).toMatchObject({ paddleCustomerId: customerId, plan: 'free', paddleSubscriptionId: null });

    // A customer already on the row is kept.
    await deliver(transaction(paddleId('ctm')));
    expect((await row(orgId)).paddleCustomerId).toBe(customerId);
  });

  it('finds the account without custom data', async () => {
    const { orgId } = await account();
    const id = paddleId('sub');
    const customerId = paddleId('ctm');
    await t.db.update(subscription).set({ paddleSubscriptionId: id, paddleCustomerId: customerId }).where(eq(subscription.orgId, orgId));
    await deliver(paddleEvent('subscription.updated', paddleSubscription({ id, customerId, priceId: BUSINESS_MONTH })));
    expect(await row(orgId)).toMatchObject({ plan: 'business', status: 'active' });

    // By the customer alone, when the subscription id is new to the API.
    const { orgId: byCustomer } = await account();
    const known = paddleId('ctm');
    await t.db.update(subscription).set({ paddleCustomerId: known }).where(eq(subscription.orgId, byCustomer));
    const newSub = paddleId('sub');
    await deliver(paddleEvent('subscription.created', paddleSubscription({ id: newSub, customerId: known, priceId: PRO_MONTH })));
    expect(await row(byCustomer)).toMatchObject({ plan: 'pro', paddleSubscriptionId: newSub });
  });

  it('cannot place it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const everySubscription = () => t.db.select().from(subscription).orderBy(subscription.orgId);

    // An unknown account, whether or not its id looks like one.
    for (const orgId of ['0192e0a4-5b6c-7d8e-9f01-23456789abcd', 'not-a-uuid']) {
      const before = await everySubscription();
      const event = paddleEvent('subscription.created', paddleSubscription({ orgId, priceId: PRO_MONTH }));
      await deliver(event);
      expect((await eventRows(event.event_id))[0].processedAt).toBeInstanceOf(Date);
      expect(await everySubscription()).toEqual(before);
      expect(warn).toHaveBeenCalledWith({ eventId: event.event_id }, expect.any(String));
    }

    // An unknown price leaves the plan as it was (P7-D5).
    const { orgId } = await account();
    const fields = { id: paddleId('sub'), customerId: paddleId('ctm'), orgId };
    await deliver(paddleEvent('subscription.created', paddleSubscription({ ...fields, priceId: PRO_MONTH }), { occurred_at: '2030-01-15T10:00:00Z' }));
    const unknownPrice = paddleEvent('subscription.updated', paddleSubscription({ ...fields, priceId: paddleId('pri') }), { occurred_at: '2030-01-16T10:00:00Z' });
    await deliver(unknownPrice);
    expect(await row(orgId)).toMatchObject({ plan: 'pro', interval: 'month', status: 'active' });
    expect((await eventRows(unknownPrice.event_id))[0].processedAt).toBeInstanceOf(Date);
    expect(warn).toHaveBeenCalledWith({ eventId: unknownPrice.event_id }, expect.any(String));

    // An event type the API does not handle.
    const before = await everySubscription();
    const unhandled = paddleEvent('subscription.paused', paddleSubscription({ ...fields, status: 'paused', priceId: PRO_MONTH }), {
      occurred_at: '2030-01-17T10:00:00Z',
    });
    await deliver(unhandled);
    expect((await eventRows(unhandled.event_id))[0]).toMatchObject({ type: 'subscription.paused', processedAt: expect.any(Date) });
    expect(await everySubscription()).toEqual(before);
    expect(warn).toHaveBeenCalledWith({ eventId: unhandled.event_id }, expect.any(String));

    // The warnings name the event and nothing else: no email, secret or signature.
    for (const [context] of warn.mock.calls) {
      if (typeof context === 'object' && context !== null && 'eventId' in context) expect(Object.keys(context)).toEqual(['eventId']);
    }
  });

  it('a signed body that is not a Paddle event answers 400 and keeps nothing', async () => {
    const res = await postWebhook(t, { event_type: 'subscription.created', occurred_at: '2030-01-15T10:00:00Z', data: {} }).expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a handler error answers 500 and keeps nothing', async () => {
    const { orgId: holder } = await account();
    const { orgId } = await account();
    const id = paddleId('sub');
    await t.db.update(subscription).set({ paddleSubscriptionId: id }).where(eq(subscription.orgId, holder));
    const before = await row(orgId);

    // The subscription id already belongs to another account, so the update breaks subscription_paddle_sub_uq.
    const event = paddleEvent('subscription.created', paddleSubscription({ id, orgId, priceId: PRO_MONTH }));
    const res = await postWebhook(t, event).expect(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL' });
    expect(await eventRows(event.event_id)).toEqual([]);
    expect(await row(orgId)).toEqual(before);

    // Paddle's retry, once the conflict is gone, is processed from scratch.
    await t.db.update(subscription).set({ paddleSubscriptionId: null }).where(eq(subscription.orgId, holder));
    await deliver(event);
    expect(await row(orgId)).toMatchObject({ plan: 'pro', paddleSubscriptionId: id });
    expect((await eventRows(event.event_id))[0].processedAt).toBeInstanceOf(Date);
  });
});
