import type { AlertItem, AlertsResponse, MarkReadResponse, NotificationPrefs, WatchlistResponse } from '@rejectradar/contracts';
import { alert, type changeEvent, uuidv7 } from '@rejectradar/db';
import { insertEvent } from '@rejectradar/entities';
import { sql } from 'drizzle-orm';
import { daysAgo, type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

type EventFields = Partial<Omit<typeof changeEvent.$inferInsert, 'source' | 'sourceKey' | 'kind'>>;

describe('alerts', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_alerts');
    fx = await seedReferenceData(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const account = async () => signUpVerified(t, { email: `user${++n}@alerts.test` });

  /** An event and the alert it raised for `orgId`, as `alerts:run` (Task 13) will leave them. */
  async function raise(orgId: string, event: EventFields = {}, row: { createdAt?: string; readAt?: string } = {}): Promise<string> {
    const eventId = await insertEvent(t.db, { source: 'fda_refusal', sourceKey: `alerts-${++n}`, ...event });
    const id = uuidv7();
    await t.db.insert(alert).values({
      id,
      orgId,
      changeEventId: eventId,
      firmId: event.firmId ?? null,
      severity: event.severity ?? 'normal',
      ...(row.createdAt ? { createdAt: new Date(row.createdAt) } : {}),
      ...(row.readAt ? { readAt: new Date(row.readAt) } : {}),
    });
    return id;
  }

  const list = async (session: TestSession, query: Record<string, string> = {}) =>
    (await session.get('/v1/alerts').query(query).expect(200)).body as AlertsResponse;
  const ids = (page: AlertsResponse) => page.items.map((item) => item.id);

  it("lists the account's alerts newest first, with both dates", async () => {
    const { session, orgId } = await account();
    const other = await account();
    const old = await raise(orgId, { occurredOn: daysAgo(30) }, { createdAt: '2026-10-01T08:00:00Z' });
    const linked = await raise(
      orgId,
      { firmId: fx.firms.zarfeen, noticeId: fx.notices.recentRefusal, occurredOn: daysAgo(10), severity: 'high', originCountry: 'PK' },
      { createdAt: '2026-10-03T08:00:00Z' },
    );
    const middle = await raise(orgId, { occurredOn: daysAgo(2) }, { createdAt: '2026-10-02T08:00:00Z' });
    await raise(other.orgId);

    const page = await list(session);
    expect(ids(page)).toEqual([linked, middle, old]);
    expect(page).toMatchObject({ next: null, unread: 3 });
    expect(page.items[0]).toMatchObject({
      id: linked,
      severity: 'high',
      kind: 'fda_refusal',
      createdAt: '2026-10-03T08:00:00.000Z',
      occurredOn: daysAgo(10),
      readAt: null,
      firm: { id: fx.firms.zarfeen, displayName: 'ZARFEEN RICE MILLS (PVT) LTD' },
      notice: { id: fx.notices.recentRefusal, noticeType: 'refusal', destination: 'US', originCountry: 'PK' },
    });
    expect(Object.keys(page.items[0].notice ?? {}).sort()).toEqual(
      ['destination', 'id', 'noticeType', 'originCountry', 'productText', 'title', 'url'].sort(),
    );
    // An event without a firm or a notice still lists.
    expect(page.items[2]).toMatchObject({ createdAt: '2026-10-01T08:00:00.000Z', occurredOn: daysAgo(30), firm: null, notice: null });
  });

  it('opens one alert of the account, as the alert email links to it', async () => {
    const { session, orgId } = await account();
    const other = await account();
    const id = await raise(orgId, { firmId: fx.firms.zarfeen, noticeId: fx.notices.recentRefusal, severity: 'high' });
    const foreign = await raise(other.orgId);

    const item = (await session.get(`/v1/alerts/${id}`).expect(200)).body as AlertItem;
    expect(item).toEqual((await list(session)).items[0]);
    expect(item).toMatchObject({ id, severity: 'high', readAt: null, firm: { id: fx.firms.zarfeen }, notice: { id: fx.notices.recentRefusal } });

    // Another account's alert, an unknown id and a malformed one are all not found.
    await session.get(`/v1/alerts/${foreign}`).expect(404);
    await session.get(`/v1/alerts/${uuidv7()}`).expect(404);
    await session.get('/v1/alerts/preview-1').expect(404);
  });

  it('filters', async () => {
    const { session, orgId } = await account();
    const riceUs = await raise(orgId, { firmId: fx.firms.zarfeen, originCountry: 'PK', commodityId: 101, destination: 'US', hazardIds: [300], severity: 'high' });
    const cerealEu = await raise(orgId, { originCountry: 'PK', commodityId: 102, destination: 'EU', hazardIds: [100] });
    const chilliUk = await raise(orgId, { originCountry: 'PK', commodityId: 201, destination: 'UK', hazardIds: [300] });
    const riceVn = await raise(orgId, { firmId: fx.firms.alRahmanLahore, originCountry: 'VN', commodityId: 101, destination: 'US' });
    await t.db.execute(sql`update alert set read_at = now() where id = ${riceVn}`);
    const sorted = (...found: string[]) => [...found].sort();
    const only = async (query: Record<string, string>) => ids(await list(session, query)).sort();

    expect(await only({})).toEqual(sorted(riceUs, cerealEu, chilliUk, riceVn));
    expect(await only({ severity: 'high' })).toEqual([riceUs]);
    expect(await only({ severity: 'normal' })).toEqual(sorted(cerealEu, chilliUk, riceVn));
    expect(await only({ unread: 'true' })).toEqual(sorted(riceUs, cerealEu, chilliUk));
    expect(await only({ firm: String(fx.firms.zarfeen) })).toEqual([riceUs]);
    expect(await only({ firm: String(fx.firms.alRahmanLahore), unread: 'true' })).toEqual([]);
    // Rice or another cereal: commodity 100 reaches its descendants (P5-D6).
    expect(await only({ origin: 'PK', commodity: '100' })).toEqual(sorted(riceUs, cerealEu));
    expect(await only({ origin: 'PK', commodity: '101' })).toEqual([riceUs]);
    expect(await only({ origin: 'PK' })).toEqual(sorted(riceUs, cerealEu, chilliUk));
    expect(await only({ origin: 'PK', destination: 'EU' })).toEqual([cerealEu]);
    expect(await only({ origin: 'PK', hazard: '300' })).toEqual(sorted(riceUs, chilliUk));
    expect(await only({ origin: 'PK', commodity: '100', hazard: '300', destination: 'US' })).toEqual([riceUs]);
    // The number on the bell is the account's, whatever the filters.
    expect((await list(session, { severity: 'high' })).unread).toBe(3);
  });

  it('refuses filters that make no sense', async () => {
    const { session } = await account();
    const queries = [{ commodity: '100' }, { hazard: '300' }, { destination: 'EU' }, { severity: 'low' }, { unread: 'false' }, { firm: '0' }, { origin: 'pk' }, { cursor: '%%%' }];
    for (const query of queries) {
      const res = await session.get('/v1/alerts').query(query).expect(400);
      expect({ query, code: (res.body as { code: string }).code }).toEqual({ query, code: 'BAD_REQUEST' });
    }
  });

  it('paging by cursor', async () => {
    const { session, orgId } = await account();
    // 120 alerts: neighbours fall in the same millisecond but not the same microsecond, and every tenth pair at exactly the same instant.
    const rows: (typeof alert.$inferInsert)[] = [];
    for (let i = 0; i < 120; i++) {
      const eventId = await insertEvent(t.db, { source: 'fda_refusal', sourceKey: `paging-${n}-${i}` });
      rows.push({ id: uuidv7(), orgId, changeEventId: eventId, severity: 'normal' });
    }
    await t.db.insert(alert).values(rows);
    await t.db.execute(sql`
      with numbered as (select id, (row_number() over (order by id))::int as i from alert where org_id = ${orgId})
      update alert set created_at = timestamptz '2026-10-01 00:00:00+00'
        + make_interval(secs => (numbered.i / 2)::int)
        + make_interval(secs => case when numbered.i % 2 = 1 and (numbered.i / 2) % 10 <> 0 then 0.0006 else 0.0001 end)
      from numbered where alert.id = numbered.id`);
    const expected = (await t.db.execute<{ id: string }>(sql`select id from alert where org_id = ${orgId} order by created_at desc, id desc`)).rows.map((r) => r.id);

    const pages: AlertsResponse[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(session, cursor ? { cursor } : {});
      pages.push(page);
      cursor = page.next ?? undefined;
    } while (cursor);

    expect(pages.map((page) => page.items.length)).toEqual([50, 50, 20]);
    expect(pages.map((page) => page.next === null)).toEqual([false, false, true]);
    expect(pages.flatMap(ids)).toEqual(expected);
    expect(new Set(expected).size).toBe(120);
    expect(pages[0].unread).toBe(120);
  });

  it('mark some and all as read', async () => {
    const { session, orgId } = await account();
    const other = await account();
    const [a, b] = [await raise(orgId), await raise(orgId), await raise(orgId)];
    const foreign = await raise(other.orgId);

    expect((await session.post('/v1/alerts/read').send({ ids: [a] }).expect(200)).body as MarkReadResponse).toEqual({ updated: 1 });
    const page = await list(session);
    expect(page.unread).toBe(2);
    expect(page.items.find((item) => item.id === a)?.readAt).not.toBeNull();
    expect(page.items.find((item) => item.id === b)?.readAt).toBeNull();

    // An alert already read is not marked again, and the ids of another account update nothing.
    expect((await session.post('/v1/alerts/read').send({ ids: [a, foreign] }).expect(200)).body).toEqual({ updated: 0 });
    const untouched = await t.db.execute<{ read_at: string | null }>(sql`select read_at from alert where id = ${foreign}`);
    expect(untouched.rows[0].read_at).toBeNull();

    expect((await session.post('/v1/alerts/read').send({ all: true }).expect(200)).body).toEqual({ updated: 2 });
    expect(await list(session, { unread: 'true' })).toMatchObject({ items: [], unread: 0 });
    expect((await session.post('/v1/alerts/read').send({ all: true }).expect(200)).body).toEqual({ updated: 0 });
    // The other account's alert is still unread after `all`.
    expect((await list(other.session)).unread).toBe(1);
  });

  it('refuses a mark-as-read it cannot understand', async () => {
    const { session } = await account();
    const bodies = [{}, { ids: [] }, { ids: ['not-a-uuid'] }, { all: false }, { ids: Array.from({ length: 201 }, () => uuidv7()) }];
    for (const body of bodies) await session.post('/v1/alerts/read').send(body).expect(400);
  });

  it('preferences default and update', async () => {
    const { session, userId } = await account();
    const other = await account();
    expect((await session.get('/v1/me/notification-prefs').expect(200)).body).toEqual({ instantHigh: true, digest: 'daily' });

    const saved = await session.put('/v1/me/notification-prefs').send({ instantHigh: false, digest: 'weekly' }).expect(200);
    expect(saved.body).toEqual({ instantHigh: false, digest: 'weekly' });
    expect((await session.get('/v1/me/notification-prefs').expect(200)).body as NotificationPrefs).toEqual({ instantHigh: false, digest: 'weekly' });
    // A second save updates the row.
    await session.put('/v1/me/notification-prefs').send({ instantHigh: true, digest: 'off' }).expect(200);
    expect((await session.get('/v1/me/notification-prefs').expect(200)).body).toEqual({ instantHigh: true, digest: 'off' });
    const stored = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from notification_pref where user_id = ${userId}`);
    expect(stored.rows[0].n).toBe(1);

    // Settings belong to the user: another user, even of a new account, still has the defaults.
    expect((await other.session.get('/v1/me/notification-prefs').expect(200)).body).toEqual({ instantHigh: true, digest: 'daily' });
    for (const body of [{}, { instantHigh: 'yes', digest: 'daily' }, { instantHigh: true, digest: 'hourly' }, { instantHigh: true }]) {
      await session.put('/v1/me/notification-prefs').send(body).expect(400);
    }
  });

  it('the watchlist shows unread counts', async () => {
    const { session, orgId } = await account();
    await setPlan(t, orgId, 'business');
    const other = await account();
    const zarfeen = fx.firms.zarfeen;
    await raise(orgId, { firmId: zarfeen, originCountry: 'PK', commodityId: 101, destination: 'US', hazardIds: [300] });
    await raise(orgId, { firmId: zarfeen, originCountry: 'PK', commodityId: 201, destination: 'UK', hazardIds: [300] });
    await raise(orgId, { firmId: zarfeen, originCountry: 'PK', commodityId: 101, destination: 'US' }, { readAt: '2026-10-02T08:00:00Z' });
    await raise(orgId, { originCountry: 'PK', commodityId: 102, destination: 'EU', hazardIds: [100] });
    await raise(orgId, { originCountry: 'VN', commodityId: 101, destination: 'US' });
    // Another account's alerts on the same firm and topic count for nothing here.
    await raise(other.orgId, { firmId: zarfeen, originCountry: 'PK', commodityId: 101, destination: 'US' });

    await session.post('/v1/watchlist').send({ kind: 'firm', firmId: zarfeen }).expect(201);
    await session.post('/v1/watchlist').send({ kind: 'firm', firmId: fx.firms.alRahmanLahore }).expect(201);
    await session.post('/v1/watchlist').send({ kind: 'topic', originCountry: 'PK', commodityId: 100 }).expect(201);
    await session.post('/v1/watchlist').send({ kind: 'topic', originCountry: 'PK', hazardId: 100 }).expect(201);
    await session.post('/v1/watchlist').send({ kind: 'topic', originCountry: 'PK', destination: 'UK' }).expect(201);
    await session.post('/v1/watchlist').send({ kind: 'topic', originCountry: 'IN' }).expect(201);

    const counts = Object.fromEntries(
      ((await session.get('/v1/watchlist').expect(200)).body as WatchlistResponse).items.map((item) => [
        item.firm ? `firm:${item.firm.id}` : `topic:${item.topic?.originCountry}:${item.topic?.commodityId}:${item.topic?.destination}:${item.topic?.hazardId}`,
        item.unreadAlerts,
      ]),
    );
    expect(counts).toEqual({
      [`firm:${zarfeen}`]: 2,
      [`firm:${fx.firms.alRahmanLahore}`]: 0,
      // Cereals (100) reach rice (101) and other cereals (102): the unread rice alert and the cereal one.
      'topic:PK:100:null:null': 2,
      'topic:PK:null:null:100': 1,
      'topic:PK:null:UK:null': 1,
      'topic:IN:null:null:null': 0,
    });

    await session.post('/v1/alerts/read').send({ all: true }).expect(200);
    const after = (await session.get('/v1/watchlist').expect(200)).body as WatchlistResponse;
    expect(after.items.map((item) => item.unreadAlerts)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
