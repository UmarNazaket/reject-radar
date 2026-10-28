import type { MembersResponse, SubscriptionResponse, WatchlistResponse } from '@rejectradar/contracts';
import { alert, lookupLog, subscription, usageCounter, uuidv7, watchlistItem } from '@rejectradar/db';
import { insertEvent, insertFirm } from '@rejectradar/entities';
import { eq, sql } from 'drizzle-orm';
import { paddleEvent, paddleId, paddleSubscription, postWebhook } from '../testing/paddle-fixtures';
import { seedReferenceData } from '../testing/reference-data';
import { joinByInvite, signUpVerified, startTestApp, type TestApp, testEnv } from '../testing/test-app';

describe('billing: downgrades keep the data and block new usage', () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_billing_downgrade');
    await seedReferenceData(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const env = testEnv('postgres://unused');
  /** Rows the account holds in the tables a downgrade must never touch. */
  const counts = async (orgId: string) => {
    const one = async (table: string) => (await t.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(table)} where org_id = ${orgId}`)).rows[0].n;
    return { watchlist: await one('watchlist_item'), members: await one('membership'), lookups: await one('lookup_log'), alerts: await one('alert') };
  };

  it('a Business account moved to Pro keeps everything and cannot add more until it is under the limits', async () => {
    const { session, orgId } = await signUpVerified(t, { email: `owner${++n}@billing-downgrade.test` });

    // Business, through a real webhook event.
    const entity = { id: paddleId('sub'), customerId: paddleId('ctm'), orgId };
    await postWebhook(
      t,
      paddleEvent('subscription.created', paddleSubscription({ ...entity, priceId: env.PADDLE_PRICE_BUSINESS_MONTHLY }), { occurred_at: new Date(Date.now() - 60_000).toISOString() }),
    ).expect(200);
    const business = (await session.get('/v1/billing/subscription').expect(200)).body as SubscriptionResponse;
    expect(business).toMatchObject({ plan: 'business', source: 'subscription', status: 'active' });

    // Four more members (five with the owner), through the API.
    for (let i = 0; i < 4; i++) await joinByInvite(t, session, { email: `member${n}-${i}@billing-downgrade.test`, role: 'member' });

    // 30 watchlist items, 150 lookups this month and an alert, seeded in SQL.
    await t.db.insert(watchlistItem).values(Array.from({ length: 30 }, (_, i) => ({ id: uuidv7(), orgId, kind: 'topic', originCountry: 'PK', topicKey: `PK|${1000 + i}|*|*` })));
    const firmIds: number[] = [];
    for (let i = 0; i < 201; i++) firmIds.push(await insertFirm(t.db, { displayName: `Downgrade Test Foods ${n}-${i}`, countryCode: 'PK' }));
    const period = business.usage.period;
    await t.db.insert(lookupLog).values(firmIds.slice(0, 150).map((firmId) => ({ orgId, firmId, period })));
    await t.db.insert(usageCounter).values({ orgId, period, lookups: 150 }).onConflictDoUpdate({ target: [usageCounter.orgId, usageCounter.period], set: { lookups: 150 } });
    const eventId = await insertEvent(t.db, { source: 'fda_refusal', sourceKey: `downgrade-${n}` });
    await t.db.insert(alert).values({ id: uuidv7(), orgId, changeEventId: eventId, severity: 'normal' });
    expect(await counts(orgId)).toEqual({ watchlist: 30, members: 5, lookups: 150, alerts: 1 });

    // The downgrade.
    await postWebhook(t, paddleEvent('subscription.updated', paddleSubscription({ ...entity, priceId: env.PADDLE_PRICE_PRO_MONTHLY }))).expect(200);
    const pro = (await session.get('/v1/billing/subscription').expect(200)).body as SubscriptionResponse;
    expect(pro).toMatchObject({ plan: 'pro', source: 'subscription', usage: { lookups: 150, watchlist: 30, members: 5 } });

    // Everything is still there.
    const list = (await session.get('/v1/watchlist').expect(200)).body as WatchlistResponse;
    expect(list.items).toHaveLength(30);
    expect(((await session.get('/v1/org/members').expect(200)).body as MembersResponse).members).toHaveLength(5);

    // New usage above the new limits is refused.
    const add = () => session.post('/v1/watchlist').send({ kind: 'topic', originCountry: 'PK', commodityId: 101 });
    const refused = await add().expect(403);
    expect(refused.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'watchlist', plan: 'pro', limit: 25, used: 30 } });
    const invite = await session.post('/v1/org/invites').send({ email: `late${n}@billing-downgrade.test`, role: 'member' }).expect(403);
    expect(invite.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'members', plan: 'pro', limit: 3, used: 5 } });

    // Pro allows 200 lookups: 50 more new firms succeed and the next is refused. A firm already opened stays free.
    for (const firmId of firmIds.slice(150, 200)) await session.get(`/v1/firms/${firmId}`).expect(200);
    const lookup = await session.get(`/v1/firms/${firmIds[200]}`).expect(403);
    expect(lookup.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'lookup', plan: 'pro', limit: 200, used: 200 } });
    await session.get(`/v1/firms/${firmIds[0]}`).expect(200);

    // Deleting down to 24 leaves room for one more.
    for (const { id } of list.items.slice(0, 6)) await session.delete(`/v1/watchlist/${id}`).expect(204);
    expect(((await session.get('/v1/watchlist').expect(200)).body as WatchlistResponse).items).toHaveLength(24);
    await add().expect(201);

    // Only the six items the owner deleted are gone: the downgrade and the refused actions removed nothing.
    expect(await counts(orgId)).toEqual({ watchlist: 25, members: 5, lookups: 200, alerts: 1 });
    const [row] = await t.db.select().from(subscription).where(eq(subscription.orgId, orgId));
    expect(row).toMatchObject({ plan: 'pro', status: 'active' });
  });
});
