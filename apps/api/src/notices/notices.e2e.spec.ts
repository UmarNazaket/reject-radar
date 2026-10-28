import type { NoticeItem, NoticeSearchResponse } from '@rejectradar/contracts';
import { lookupLog, notice, usageCounter } from '@rejectradar/db';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { daysAgo, type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('notice search', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let pro: { session: TestSession; orgId: string };

  beforeAll(async () => {
    t = await startTestApp('api_notices');
    fx = await seedReferenceData(t.db);
    pro = await signUpVerified(t, { email: 'pro@notices.test' });
    await setPlan(t, pro.orgId, 'pro');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const search = async (query: string, session: TestSession = pro.session): Promise<NoticeSearchResponse> => {
    const res = await session.get(`/v1/notices${query}`).expect(200);
    return res.body as NoticeSearchResponse;
  };
  const ids = (response: NoticeSearchResponse): number[] => response.items.map((item) => item.id);

  it('filters combine', async () => {
    const res = await search('?origin=PK&destination=US,AU');
    expect(ids(res)).toEqual([
      fx.notices.recentRefusal,
      fx.notices.au,
      fx.notices.listing,
      fx.notices.refusal13Months,
      fx.notices.refusal4Years,
    ]);
    expect(res.next).toBeNull();
    expect(res.historyFrom).toBeNull();
    expect(res.items[0]).toEqual({
      id: fx.notices.recentRefusal,
      source: 'fda_refusal',
      noticeType: 'refusal',
      destination: 'US',
      noticeOn: daysAgo(10),
      originCountry: 'PK',
      commodityId: 101,
      hazardIds: [300],
      productText: 'Basmati Rice, milled',
      firmName: 'ZARFEEN RICE MILLS (PVT) LTD',
      firmId: fx.firms.zarfeen,
      title: 'ZARFEEN RICE MILLS (PVT) LTD refused: Basmati Rice, milled',
      url: null,
    });
  });

  it('with only an origin it lists that origin, newest first', async () => {
    const res = await search('?origin=PK');
    expect(ids(res)).toEqual([
      fx.notices.recentRefusal,
      fx.notices.rasff,
      fx.notices.au,
      fx.notices.listing,
      fx.notices.refusal13Months,
      fx.notices.refusal4Years,
    ]);
  });

  it('filters by source and date range', async () => {
    expect(ids(await search(`?source=rasff,uk_bn&from=${daysAgo(35)}&to=${daysAgo(15)}`))).toEqual([fx.notices.rasff, fx.notices.uk]);
    expect(ids(await search(`?origin=PK&from=${daysAgo(45)}&to=${daysAgo(15)}`))).toEqual([fx.notices.rasff, fx.notices.au]);
    // The bounds are inclusive.
    expect(ids(await search(`?from=${daysAgo(20)}&to=${daysAgo(20)}`))).toEqual([fx.notices.rasff]);
  });

  it('a commodity filter includes descendants', async () => {
    expect(ids(await search('?commodity=200'))).toEqual([fx.notices.uk]);
    expect(ids(await search('?commodity=201'))).toEqual([fx.notices.uk]);
    expect(ids(await search('?commodity=100&origin=IN'))).toEqual([]);
  });

  it('hazard and category', async () => {
    expect(ids(await search('?hazard=300'))).toEqual([
      fx.notices.recentRefusal,
      fx.notices.uk,
      fx.notices.refusal13Months,
      fx.notices.refusal4Years,
    ]);
    expect(ids(await search('?hazardCategory=pesticide_residues'))).toEqual([fx.notices.rasff]);
    expect(ids(await search('?hazardCategory=mycotoxins&destination=UK'))).toEqual([fx.notices.uk]);
  });

  it('free text', async () => {
    expect(ids(await search('?q=basmati'))).toEqual([fx.notices.recentRefusal]);
    expect(ids(await search('?q=%20%20CHILLI%20'))).toEqual([fx.notices.uk]);

    await t.db.insert(notice).values(
      ['Rice 100% broken', 'Rice 1000 bags', 'Rice 100_ grade'].map((productText, i) => ({
        source: 'rasff',
        sourceKey: `like-${i}`,
        destination: 'EU',
        noticeType: 'rasff_alert',
        noticeOn: daysAgo(3),
        originCountry: 'BD',
        productText,
      })),
    );
    const percent = await search('?origin=BD&q=100%25');
    expect(percent.items.map((item) => item.productText)).toEqual(['Rice 100% broken']);
    const underscore = await search('?origin=BD&q=100_');
    expect(underscore.items.map((item) => item.productText)).toEqual(['Rice 100_ grade']);
    // The percent sign is no wildcard anywhere in the base fixture either.
    expect(ids(await search('?q=100%25'))).toHaveLength(1);
  });

  it('keyset paging', async () => {
    await t.db.insert(notice).values(
      Array.from({ length: 120 }, (_, i) => ({
        source: 'uk_bn',
        sourceKey: `paging-${i}`,
        destination: 'UK',
        noticeType: 'uk_border_notification',
        noticeOn: daysAgo(5),
        originCountry: 'LK',
        productText: `Cinnamon ${i}`,
      })),
    );
    const first = await search('?origin=LK');
    expect(first.items).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const second = await search(`?origin=LK&cursor=${first.next}`);
    expect(second.items).toHaveLength(50);
    expect(second.next).not.toBeNull();
    const third = await search(`?origin=LK&cursor=${second.next}`);
    expect(third.items).toHaveLength(20);
    expect(third.next).toBeNull();

    const all = [...ids(first), ...ids(second), ...ids(third)];
    expect(new Set(all).size).toBe(120);
    expect(all).toEqual([...all].sort((a, b) => b - a)); // one date, so newest id first
  });

  it('a cursor that is not valid is a 400', async () => {
    const res = await pro.session.get('/v1/notices?cursor=%25%25%25').expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it.each([
    'origin=pk',
    'origin=PAK',
    'destination=XX',
    'source=nope',
    'commodity=0',
    'commodity=abc',
    'hazardCategory=nope',
    'from=2026-13-01',
    'q=ab',
    `q=${'x'.repeat(101)}`,
  ])('rejects %s', async (query) => {
    const res = await pro.session.get(`/v1/notices?${query}`).expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('free sees 12 months', async () => {
    const free = await signUpVerified(t, { email: 'free@notices.test' });
    const expected = await t.app.get(EntitlementsService).historyFrom(free.orgId);
    expect(expected).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const res = await search('?origin=PK&destination=US,AU', free.session);
    expect(ids(res)).toEqual([fx.notices.recentRefusal, fx.notices.au, fx.notices.listing]);
    expect(res.historyFrom).toBe(expected);

    // A `from` before the window is clamped to it.
    const early = await search(`?origin=PK&from=${daysAgo(2000)}`, free.session);
    expect(ids(early)).toEqual([fx.notices.recentRefusal, fx.notices.rasff, fx.notices.au, fx.notices.listing]);

    const detail = await free.session.get(`/v1/notices/${fx.notices.refusal13Months}`).expect(403);
    expect(detail.body).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', details: { feature: 'notice_history', plan: 'free' } });
    await free.session.get(`/v1/notices/${fx.notices.recentRefusal}`).expect(200);
  });

  it('an unverified user can search', async () => {
    const session = t.session();
    await session
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: 'unverified@notices.test', password: 'zarfeen-rice-2026', companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await session.post('/v1/auth/login').send({ email: 'unverified@notices.test', password: 'zarfeen-rice-2026' }).expect(200);
    const res = await search('?origin=PK', session);
    expect(res.items.length).toBeGreaterThan(0);
    await session.get(`/v1/notices/${fx.notices.recentRefusal}`).expect(200);
  });

  it('needs a session', async () => {
    await t.session().get('/v1/notices').expect(401);
    await t.session().get(`/v1/notices/${fx.notices.recentRefusal}`).expect(401);
  });

  it('returns one notice', async () => {
    const res = await pro.session.get(`/v1/notices/${fx.notices.uk}`).expect(200);
    expect(res.body as NoticeItem).toEqual({
      id: fx.notices.uk,
      source: 'uk_bn',
      noticeType: 'uk_border_notification',
      destination: 'UK',
      noticeOn: daysAgo(30),
      originCountry: 'IN',
      commodityId: 201,
      hazardIds: [300],
      productText: 'Dried chilli powder',
      firmName: null,
      firmId: null,
      title: 'Dried chilli powder from India: aflatoxins above the legal limit',
      url: null,
    });
    // Pro reaches every notice, the 4-year-old refusal included.
    await pro.session.get(`/v1/notices/${fx.notices.refusal4Years}`).expect(200);
  });

  it('404 for an unknown id', async () => {
    const missing = await pro.session.get('/v1/notices/987654321').expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
    await pro.session.get('/v1/notices/abc').expect(404);
    await pro.session.get('/v1/notices/0').expect(404);
    await pro.session.get('/v1/notices/-5').expect(404);
  });

  it('searching uses no lookup', async () => {
    await search('?origin=PK');
    await pro.session.get(`/v1/notices/${fx.notices.recentRefusal}`).expect(200);
    expect(await t.db.select().from(usageCounter)).toEqual([]);
    expect(await t.db.select().from(lookupLog)).toEqual([]);
  });
});
