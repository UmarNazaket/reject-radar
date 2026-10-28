import type { DashboardResponse, Destination } from '@rejectradar/contracts';
import { notice } from '@rejectradar/db';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { daysAgo, type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

/** `YYYY-MM` of the UTC month `back` months before the current one. */
function monthBack(back: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
}

const NONE = { US: 0, EU: 0, UK: 0, AU: 0 };
const SOURCE = { US: 'fda_refusal', EU: 'rasff', UK: 'uk_bn', AU: 'au_ifis' } as const;
const NOTICE_TYPE = { US: 'refusal', EU: 'rasff_alert', UK: 'uk_border_notification', AU: 'au_failed_test' } as const;

describe('topic dashboard', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let pro: { session: TestSession; orgId: string };

  beforeAll(async () => {
    t = await startTestApp('api_dashboards');
    fx = await seedReferenceData(t.db);
    pro = await signUpVerified(t, { email: 'pro@dashboards.test' });
    await setPlan(t, pro.orgId, 'pro');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const dashboard = async (query: string, session: TestSession = pro.session): Promise<DashboardResponse> => {
    const res = await session.get(`/v1/dashboards/topic${query}`).expect(200);
    return res.body as DashboardResponse;
  };

  let counter = 0;
  /** Notices under an origin the base fixture never uses, so they leave the PK numbers alone (ruling R3). */
  const addNotices = (origin: string, rows: { destination: Destination; age: number; hazardIds?: number[]; commodityId?: number }[]) =>
    t.db.insert(notice).values(
      rows.map((row) => ({
        source: SOURCE[row.destination],
        sourceKey: `dash-${origin}-${counter++}`,
        destination: row.destination,
        noticeType: NOTICE_TYPE[row.destination],
        noticeOn: daysAgo(row.age),
        originCountry: origin,
        commodityId: row.commodityId ?? null,
        hazardIds: row.hazardIds ?? [],
        productText: `Dashboard test ${counter}`,
      })),
    );

  it('has 36 zero-filled months on pro, oldest first', async () => {
    const res = await dashboard('?origin=PK&commodity=100');
    expect(res.months).toHaveLength(36);
    expect(res.months[0].month).toBe(monthBack(35));
    expect(res.months[35].month).toBe(monthBack(0));
    expect(res.months.map((m) => m.month)).toEqual(Array.from({ length: 36 }, (_, i) => monthBack(35 - i)));

    const empty = await dashboard('?origin=ZZ');
    expect(empty.months).toHaveLength(36);
    expect(empty.months.every((m) => m.US === 0 && m.EU === 0 && m.UK === 0 && m.AU === 0)).toBe(true);
    expect(empty.totals12m).toEqual(NONE);
    expect(empty.hazardCategories).toEqual([]);
    expect(empty.findings).toEqual([]);
    expect(empty.commodities).toEqual([]);
    expect(empty.latest).toEqual([]);
  });

  it('splits the months by destination', async () => {
    const res = await dashboard('?origin=PK&commodity=100');
    const expected = new Map<string, typeof NONE>();
    const tally = (age: number, destination: Destination) => {
      const month = daysAgo(age).slice(0, 7);
      const row = expected.get(month) ?? { ...NONE };
      row[destination] += 1;
      expected.set(month, row);
    };
    tally(10, 'US'); // the recent refusal
    tally(400, 'US'); // the 13-month refusal
    tally(60, 'US'); // the listing
    tally(20, 'EU'); // RASFF
    tally(40, 'AU');
    // The 4-year refusal is older than 36 months.
    for (const { month, ...counts } of res.months) {
      expect(counts).toEqual(expected.get(month) ?? NONE);
    }
    const recent = res.months.find((m) => m.month === daysAgo(10).slice(0, 7));
    expect(recent?.US).toBeGreaterThanOrEqual(1);
    const rasff = res.months.find((m) => m.month === daysAgo(20).slice(0, 7));
    expect(rasff?.EU).toBe(1);
  });

  it('totals the last 12 months', async () => {
    const res = await dashboard('?origin=PK&commodity=100');
    // The 10-day refusal, the listing, RASFF and AU; the 13-month refusal is out.
    expect(res.totals12m).toEqual({ US: 2, EU: 1, UK: 0, AU: 1 });
  });

  it('counts a notice once for each hazard and once for each category', async () => {
    await addNotices('BD', [
      { destination: 'US', age: 5, hazardIds: [300, 301], commodityId: 101 },
      { destination: 'EU', age: 6, hazardIds: [300], commodityId: 101 },
      { destination: 'UK', age: 7, hazardIds: [100], commodityId: 201 },
    ]);
    const res = await dashboard('?origin=BD');
    expect(res.hazardCategories).toEqual([
      { category: 'mycotoxins', count: 2 }, // [300, 301] counts once, [300] once
      { category: 'pesticide_residues', count: 1 },
    ]);
    expect(res.findings).toEqual([
      { hazardId: 300, count: 2, byDestination: { US: 1, EU: 1, UK: 0, AU: 0 } },
      { hazardId: 100, count: 1, byDestination: { US: 0, EU: 0, UK: 1, AU: 0 } },
      { hazardId: 301, count: 1, byDestination: { US: 1, EU: 0, UK: 0, AU: 0 } },
    ]);
    for (const finding of res.findings) {
      const { US, EU, UK, AU } = finding.byDestination;
      expect(US + EU + UK + AU).toBe(finding.count);
    }
    expect(res.commodities).toEqual([
      { commodityId: 101, count: 2 },
      { commodityId: 201, count: 1 },
    ]);
  });

  it('shows the hazards, categories and commodities of the base fixture', async () => {
    const res = await dashboard('?origin=PK');
    expect(res.hazardCategories).toEqual([
      { category: 'mycotoxins', count: 1 },
      { category: 'pesticide_residues', count: 1 },
    ]);
    expect(res.findings).toEqual([
      { hazardId: 100, count: 1, byDestination: { US: 0, EU: 1, UK: 0, AU: 0 } },
      { hazardId: 300, count: 1, byDestination: { US: 1, EU: 0, UK: 0, AU: 0 } },
    ]);
    expect(res.commodities).toEqual([{ commodityId: 101, count: 4 }]);
  });

  it('a commodity filter includes descendants', async () => {
    const res = await dashboard('?origin=IN&commodity=200');
    expect(res.totals12m).toEqual({ ...NONE, UK: 1 });
    expect(res.commodities).toEqual([{ commodityId: 201, count: 1 }]);
    expect(res.latest.map((item) => item.id)).toEqual([fx.notices.uk]);
  });

  it('the destination filter narrows everything', async () => {
    const res = await dashboard('?origin=PK&commodity=100&destination=EU');
    expect(res.totals12m).toEqual({ ...NONE, EU: 1 });
    expect(res.months.reduce((sum, m) => sum + m.US + m.EU + m.UK + m.AU, 0)).toBe(1);
    expect(res.months.every((m) => m.US === 0 && m.UK === 0 && m.AU === 0)).toBe(true);
    expect(res.hazardCategories).toEqual([{ category: 'pesticide_residues', count: 1 }]);
    expect(res.findings).toEqual([{ hazardId: 100, count: 1, byDestination: { ...NONE, EU: 1 } }]);
    expect(res.commodities).toEqual([{ commodityId: 101, count: 1 }]);
    expect(res.latest.map((item) => item.id)).toEqual([fx.notices.rasff]);

    const two = await dashboard('?origin=PK&destination=EU,AU');
    expect(two.totals12m).toEqual({ ...NONE, EU: 1, AU: 1 });
  });

  it('free gets 12 months', async () => {
    const free = await signUpVerified(t, { email: 'free@dashboards.test' });
    const expected = await t.app.get(EntitlementsService).historyFrom(free.orgId);
    const res = await dashboard('?origin=PK&commodity=100', free.session);
    expect(res.months).toHaveLength(12);
    expect(res.months[0].month).toBe(monthBack(11));
    expect(res.months[11].month).toBe(monthBack(0));
    expect(res.historyFrom).toBe(expected);
    expect(res.historyFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.totals12m).toEqual({ US: 2, EU: 1, UK: 0, AU: 1 });
    expect(res.latest.map((item) => item.id)).toEqual([fx.notices.recentRefusal, fx.notices.rasff, fx.notices.au, fx.notices.listing]);
    expect((await dashboard('?origin=PK&commodity=100')).historyFrom).toBeNull();
  });

  it('latest is capped at 20, newest first', async () => {
    await addNotices(
      'LK',
      Array.from({ length: 25 }, (_, i) => ({ destination: 'UK' as const, age: 1 + (i % 5), commodityId: 201 })),
    );
    const res = await dashboard('?origin=LK');
    expect(res.latest).toHaveLength(20);
    const keys = res.latest.map((item) => `${item.noticeOn}|${String(item.id).padStart(12, '0')}`);
    expect(keys).toEqual([...keys].sort().reverse());
    expect(res.latest[0].noticeOn).toBe(daysAgo(1));
    expect(res.latest[0]).toMatchObject({ source: 'uk_bn', destination: 'UK', originCountry: 'LK', commodityId: 201 });
    expect(res.totals12m.UK).toBe(25);
  });

  it('caps the lists at 6 categories, 10 findings and 6 commodities', async () => {
    // Twelve hazards, one per category, with falling counts; eight distinct commodities.
    const hazardIds = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200];
    const commodityIds = [101, 102, 201, 202, 203, 204, 205, 301];
    const rows = hazardIds.flatMap((id, i) =>
      Array.from({ length: 20 - i }, (_, j) => ({
        destination: 'US' as const,
        age: 1 + (j % 20),
        hazardIds: [id],
        commodityId: commodityIds[(i + j) % commodityIds.length],
      })),
    );
    await addNotices('MM', rows);
    const res = await dashboard('?origin=MM');
    expect(res.hazardCategories).toHaveLength(6);
    expect(res.hazardCategories.map((c) => c.count)).toEqual([20, 19, 18, 17, 16, 15]);
    expect(res.findings).toHaveLength(10);
    expect(res.findings.map((f) => f.hazardId)).toEqual(hazardIds.slice(0, 10));
    expect(res.commodities).toHaveLength(6);
    expect(res.commodities.map((c) => c.count)).toEqual([...res.commodities.map((c) => c.count)].sort((a, b) => b - a));
  });

  it('carries the freshness of the sources', async () => {
    const res = await dashboard('?origin=PK');
    expect(res.freshness.find((f) => f.source === 'eu_mrl')?.stale).toBe(true);
    expect(res.freshness.find((f) => f.source === 'fda_refusals')?.stale).toBe(false);
  });

  it.each([
    '',
    '?origin=pk',
    '?origin=PAK',
    '?origin=PK&destination=XX',
    '?origin=PK&commodity=0',
    '?origin=PK&commodity=2147483648',
    '?commodity=100',
  ])('rejects %s', async (query) => {
    const res = await pro.session.get(`/v1/dashboards/topic${query}`).expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('needs a session', async () => {
    await t.session().get('/v1/dashboards/topic?origin=PK').expect(401);
  });
});
