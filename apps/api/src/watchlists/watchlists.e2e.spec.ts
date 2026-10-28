import type { WatchlistItem, WatchlistResponse } from '@rejectradar/contracts';
import { watchlistItem } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { daysAgo, type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('watchlist', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_watchlists');
    fx = await seedReferenceData(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  /** A fresh verified account, on the free plan (three places) unless `plan` says otherwise. */
  async function account(plan?: 'business') {
    const who = await signUpVerified(t, { email: `user${++n}@watchlist.test` });
    if (plan) await setPlan(t, who.orgId, plan);
    return who;
  }

  const add = (session: TestSession, body: unknown) => session.post('/v1/watchlist').send(body as object);
  const list = async (session: TestSession) => (await session.get('/v1/watchlist').expect(200)).body as WatchlistResponse;
  const topic = (originCountry: string, extra: Record<string, unknown> = {}) => ({ kind: 'topic', originCountry, ...extra });
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const rows = (orgId: string) => t.db.select().from(watchlistItem).where(eq(watchlistItem.orgId, orgId));

  it('adds a firm and a topic', async () => {
    const { session } = await account();
    const firm = await add(session, { kind: 'firm', firmId: fx.firms.zarfeen, inputName: 'zarfeen rice' }).expect(201);
    await add(session, topic('PK', { commodityId: 101, label: 'Rice from Pakistan' })).expect(201);
    expect((firm.body as WatchlistItem).firm?.id).toBe(fx.firms.zarfeen);

    const page = await list(session);
    expect(page).toMatchObject({ used: 2, limit: 3 });
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.kind).sort()).toEqual(['firm', 'topic']);
    expect(page.items.find((item) => item.kind === 'firm')).toMatchObject({ inputName: 'zarfeen rice', label: null, unreadAlerts: 0 });
  });

  it('the topic key is built by the API', async () => {
    const { session, orgId } = await account();
    await add(session, topic('PK', { commodityId: 101 })).expect(201);
    const [row] = await rows(orgId);
    expect(row).toMatchObject({ kind: 'topic', topicKey: 'PK|101|*|*', originCountry: 'PK', commodityId: 101, destination: null, hazardId: null, firmId: null });
  });

  it('the fourth item on free is refused', async () => {
    const { session, orgId } = await account();
    for (const origin of ['LK', 'BD', 'VN']) await add(session, topic(origin)).expect(201);
    const res = await add(session, topic('TH')).expect(403);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'watchlist', plan: 'free', limit: 3, used: 3 } });
    expect(await rows(orgId)).toHaveLength(3);
  });

  it('two adds of the last place at once', async () => {
    const { session, orgId } = await account();
    await add(session, topic('LK')).expect(201);
    await add(session, topic('BD')).expect(201);
    const results = await Promise.all([add(session, topic('VN')), add(session, topic('TH'))]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 403]);
    expect(results.find((res) => res.status === 403)?.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    expect(await rows(orgId)).toHaveLength(3);
  });

  it('a merged-away id is the same firm', async () => {
    const watched = await account();
    await add(watched.session, { kind: 'firm', firmId: fx.firms.zarfeen }).expect(201);
    const res = await add(watched.session, { kind: 'firm', firmId: fx.firms.mergedAway }).expect(409);
    expect(code(res)).toBe('ALREADY_WATCHED');

    const alone = await account();
    const added = await add(alone.session, { kind: 'firm', firmId: fx.firms.mergedAway }).expect(201);
    expect((added.body as WatchlistItem).firm?.id).toBe(fx.firms.zarfeen);
    expect((await rows(alone.orgId)).map((row) => row.firmId)).toEqual([fx.firms.zarfeen]);
  });

  it('the same firm or topic twice is refused', async () => {
    const { session, orgId } = await account();
    await add(session, topic('PK', { commodityId: 101, destination: 'US' })).expect(201);
    const again = await add(session, topic('PK', { commodityId: 101, destination: 'US', label: 'again' })).expect(409);
    expect(code(again)).toBe('ALREADY_WATCHED');
    await add(session, { kind: 'firm', firmId: fx.firms.alRahmanLahore }).expect(201);
    expect(code(await add(session, { kind: 'firm', firmId: fx.firms.alRahmanLahore }).expect(409))).toBe('ALREADY_WATCHED');
    // A refused duplicate takes no place: a different topic still fits.
    await add(session, topic('PK', { commodityId: 101 })).expect(201);
    expect(await rows(orgId)).toHaveLength(3);
  });

  it('an unknown firm is 404, an unknown commodity or hazard 400', async () => {
    const { session, orgId } = await account();
    expect(code(await add(session, { kind: 'firm', firmId: 2_000_000_000 }).expect(404))).toBe('NOT_FOUND');
    expect(code(await add(session, topic('PK', { commodityId: 999 })).expect(400))).toBe('BAD_REQUEST');
    expect(code(await add(session, topic('PK', { hazardId: 999 })).expect(400))).toBe('BAD_REQUEST');
    expect(await rows(orgId)).toHaveLength(0);
  });

  it('refuses a malformed body', async () => {
    const { session } = await account();
    for (const body of [
      { kind: 'other' },
      { kind: 'firm' },
      { kind: 'firm', firmId: 0 },
      { kind: 'firm', firmId: 1.5 },
      { kind: 'topic' },
      { kind: 'topic', originCountry: 'pk' },
      topic('PK', { destination: 'CN' }),
      topic('PK', { label: 'x'.repeat(101) }),
      topic('PK', { notes: 'x'.repeat(1001) }),
    ]) {
      expect({ body, status: (await add(session, body)).status }).toEqual({ body, status: 400 });
    }
  });

  it('needs a verified email to add, but not to read', async () => {
    const unverified = t.session();
    await unverified
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: 'unverified@watchlist.test', password: 'zarfeen-rice-2026', companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await unverified.post('/v1/auth/login').send({ email: 'unverified@watchlist.test', password: 'zarfeen-rice-2026' }).expect(200);
    const res = await add(unverified, topic('PK')).expect(403);
    expect(code(res)).toBe('EMAIL_NOT_VERIFIED');
    expect(await list(unverified)).toEqual({ items: [], used: 0, limit: 3 });
  });

  it('topic facts: notices in the last 12 months, with descendants', async () => {
    const { session } = await account();
    await add(session, topic('PK', { commodityId: 101 })).expect(201);
    await add(session, topic('PK')).expect(201);
    await add(session, topic('LK')).expect(201);
    const items = (await list(session)).items;
    const byKey = (origin: string, commodityId: number | null) =>
      items.find((item) => item.topic?.originCountry === origin && item.topic.commodityId === commodityId) as WatchlistItem;

    // P5-D6: the 10-day refusal, the 60-day listing, the 20-day RASFF and the 40-day AU failure; the 13-month refusal is outside the window.
    expect(byKey('PK', 101)).toMatchObject({
      kind: 'topic',
      firm: null,
      topic: { originCountry: 'PK', commodityId: 101, destination: null, hazardId: null, notices12m: 4 },
      lastRecordOn: daysAgo(10),
    });
    expect(byKey('PK', null).topic?.notices12m).toBeGreaterThanOrEqual(4);
    expect(byKey('LK', null)).toMatchObject({ topic: { notices12m: 0 }, lastRecordOn: null });

    const estimate = await session.get('/v1/watchlist/topic-estimate?originCountry=PK&commodityId=101').expect(200);
    expect(estimate.body).toEqual({ total12m: 4, perMonth: 0.3 });
    const none = await session.get('/v1/watchlist/topic-estimate?originCountry=LK').expect(200);
    expect(none.body).toEqual({ total12m: 0, perMonth: 0 });
    // One topic part narrows the count: the EU is the RASFF alert alone.
    const eu = await session.get('/v1/watchlist/topic-estimate?originCountry=PK&commodityId=101&destination=EU').expect(200);
    expect(eu.body).toEqual({ total12m: 1, perMonth: 0.1 });
  });

  it('topic-estimate validates its query', async () => {
    const { session } = await account();
    await session.get('/v1/watchlist/topic-estimate').expect(400);
    await session.get('/v1/watchlist/topic-estimate?originCountry=pk').expect(400);
    await session.get('/v1/watchlist/topic-estimate?originCountry=PK&commodityId=abc').expect(400);
    await session.get('/v1/watchlist/topic-estimate?originCountry=PK&destination=CN').expect(400);
  });

  it('firm facts: the red-list listing of ZARFEEN', async () => {
    const { session } = await account();
    await add(session, { kind: 'firm', firmId: fx.firms.zarfeen }).expect(201);
    const [item] = (await list(session)).items;
    expect(item).toMatchObject({
      kind: 'firm',
      topic: null,
      firm: { id: fx.firms.zarfeen, displayName: 'ZARFEEN RICE MILLS (PVT) LTD', countryCode: 'PK' },
      lastRecordOn: daysAgo(10),
    });
    expect(item.firm?.facts.import_alert_red[0].alert).toBe('99-08');
  });

  it('changes the label and notes, and deletes', async () => {
    const { session, orgId } = await account();
    const id = ((await add(session, topic('LK', { label: 'first' })).expect(201)).body as WatchlistItem).id;

    await session.patch(`/v1/watchlist/${id}`).send({ label: 'Sri Lanka', notes: 'Watch the spice season.' }).expect(200);
    expect((await list(session)).items[0]).toMatchObject({ id, label: 'Sri Lanka', notes: 'Watch the spice season.' });
    // `null` clears one field and leaves the other.
    const cleared = await session.patch(`/v1/watchlist/${id}`).send({ label: null }).expect(200);
    expect(cleared.body).toMatchObject({ id, label: null, notes: 'Watch the spice season.' });
    await session.patch(`/v1/watchlist/${id}`).send({}).expect(400);
    await session.patch(`/v1/watchlist/${id}`).send({ label: 'x'.repeat(101) }).expect(400);

    await session.delete(`/v1/watchlist/${id}`).expect(204);
    expect(await rows(orgId)).toHaveLength(0);
    expect(code(await session.delete(`/v1/watchlist/${id}`).expect(404))).toBe('NOT_FOUND');
    expect(code(await session.patch(`/v1/watchlist/${id}`).send({ label: 'x' }).expect(404))).toBe('NOT_FOUND');
    expect(code(await session.delete('/v1/watchlist/not-a-uuid').expect(404))).toBe('NOT_FOUND');
    // The freed place can be used again.
    for (const origin of ['LK', 'BD', 'VN']) await add(session, topic(origin)).expect(201);
  });

  it("another account's item is 404, and untouched", async () => {
    const a = await account();
    const b = await account();
    const id = ((await add(b.session, topic('LK', { label: 'mine' })).expect(201)).body as WatchlistItem).id;
    await a.session.patch(`/v1/watchlist/${id}`).send({ label: 'taken' }).expect(404);
    await a.session.delete(`/v1/watchlist/${id}`).expect(404);
    expect((await list(b.session)).items[0]).toMatchObject({ id, label: 'mine' });
    expect(await list(a.session)).toEqual({ items: [], used: 0, limit: 3 });
  });

  it('lists the newest first, and a business account holds more', async () => {
    const { session } = await account('business');
    for (const origin of ['LK', 'BD', 'VN', 'TH']) await add(session, topic(origin)).expect(201);
    const page = await list(session);
    expect(page.items.map((item) => item.topic?.originCountry)).toEqual(['TH', 'VN', 'BD', 'LK']);
    expect(page.used).toBe(4);
    expect(page.limit).toBeGreaterThan(3);
  });

  describe('export.csv', () => {
    it('is a CSV with a header row, and neutralises a formula in the label', async () => {
      const { session } = await account();
      await add(session, { kind: 'firm', firmId: fx.firms.zarfeen, label: '=1+1' }).expect(201);
      await add(session, topic('PK', { commodityId: 101, destination: 'US', hazardId: 300, notes: 'a, "quoted" note' })).expect(201);

      const res = await session.get('/v1/watchlist/export.csv').expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[^"]+\.csv"$/);
      const lines = res.text.split('\r\n').filter((line) => line !== '');
      expect(lines[0]).toBe('kind,name,label,notes,country,commodity,destination,hazard,last_record_on,unread_alerts');
      expect(lines).toHaveLength(3);
      expect(res.text).toContain("'=1+1");
      expect(res.text).not.toMatch(/(^|,)=1\+1/m);
      const firmLine = lines.find((line) => line.startsWith('firm,')) as string;
      expect(firmLine).toBe(`firm,ZARFEEN RICE MILLS (PVT) LTD,'=1+1,,PK,,,,${daysAgo(10)},0`);
      const topicLine = lines.find((line) => line.startsWith('topic,')) as string;
      expect(topicLine).toBe(`topic,,,"a, ""quoted"" note",PK,101,US,300,${daysAgo(10)},0`);
    });

    it('is just the header for an empty watchlist', async () => {
      const { session } = await account();
      const res = await session.get('/v1/watchlist/export.csv').expect(200);
      expect(res.text).toBe('kind,name,label,notes,country,commodity,destination,hazard,last_record_on,unread_alerts\r\n');
    });
  });
});
