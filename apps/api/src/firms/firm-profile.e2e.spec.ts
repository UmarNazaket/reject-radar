import type { FirmProfileResponse } from '@rejectradar/contracts';
import { fdaRefusal, lookupLog, usageCounter } from '@rejectradar/db';
import { insertFirm, insertRefusal } from '@rejectradar/entities';
import { eq } from 'drizzle-orm';
import { type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { FirmProfileService } from './firm-profile.service';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('firm profile', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_firm_profile');
    fx = await seedReferenceData(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  /** A verified account of its own, so lookups never carry over between specs. */
  async function account(plan: 'free' | 'pro' = 'pro') {
    const who = await signUpVerified(t, { email: `user${++n}@firm-profile.test` });
    if (plan !== 'free') await setPlan(t, who.orgId, plan);
    return who;
  }

  const open = async (session: TestSession, id: number) => {
    const res = await session.get(`/v1/firms/${id}`).expect(200);
    return res.body as FirmProfileResponse;
  };

  it("ZARFEEN's facts", async () => {
    const { session } = await account();
    const profile = await open(session, fx.firms.zarfeen);
    expect(profile).toMatchObject({
      id: fx.firms.zarfeen,
      displayName: 'ZARFEEN RICE MILLS (PVT) LTD',
      feis: ['3001234567'],
      commodityIds: [101],
    });
    expect(profile.facts).toMatchObject({ fda_refusals_12m: 1, fda_refusals_3y: 2, au_failed_3y: 1, au_holding_order: true });
    expect(profile.facts.import_alert_red.map((l) => l.alert)).toEqual(['99-08']);
    expect(profile.metrics).toMatchObject({ fda_refusals_total: 3, au_failed_total: 1, import_alert_red_current: 1 });
    expect(profile.freshness.length).toBeGreaterThan(0);
  });

  it('records newest first, all of them, with the names of their charges', async () => {
    const { session } = await account();
    const profile = await open(session, fx.firms.zarfeen);
    expect(profile.refusals).toHaveLength(3);
    const dates = profile.refusals.map((r) => r.refusalDate);
    expect(dates).toEqual([...dates].sort().reverse());
    // The 4-year-old refusal is there too (P5-D10).
    expect(Date.now() - Date.parse(dates[2])).toBeGreaterThan(3 * 365 * 24 * 3600 * 1000);
    expect(profile.refusals[0]).toMatchObject({
      productCode: '25AEC99',
      productDesc: 'Basmati Rice, milled',
      fdaSampleAnalysis: true,
      privateLabAnalysis: null,
      charges: [{ code: '2561', name: 'PESTICIDE', description: expect.stringContaining('pesticide') }],
    });

    expect(profile.listings).toEqual([
      expect.objectContaining({
        alertNumber: '99-08',
        list: 'red',
        removedOn: null,
        url: 'https://www.accessdata.fda.gov/cms_ia/importalert_99-08.html',
        products: [expect.objectContaining({ productCode: '25AEC99', productName: 'Rice, milled', removedOn: null })],
      }),
    ]);
    expect(profile.listings[0].alertTitle).toContain('Detention Without Physical Examination');

    expect(profile.auFailures).toEqual([
      expect.objectContaining({
        productDesc: 'White rice, long grain',
        testApplied: 'Pesticide residues',
        holdingOrderMatch: true,
        reportMonth: expect.stringMatching(/^\d{4}-\d{2}$/),
        failedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    ]);
  });

  it("takes the record's link from its notice, and a charge FDA does not list has no name", async () => {
    const { session } = await account();
    const firmId = await insertFirm(t.db, { displayName: 'Unlisted Charge Foods', countryCode: 'PK' });
    await insertRefusal(
      t.db,
      { firmId, chargeCodes: ['9999'], refusalDate: '2026-01-10' },
      { notice: { url: 'https://example.test/refusal/1' } },
    );
    await insertRefusal(t.db, { firmId, chargeCodes: [], refusalDate: '2026-01-05' });
    const profile = await open(session, firmId);
    expect(profile.refusals.map((r) => [r.url, r.charges])).toEqual([
      ['https://example.test/refusal/1', [{ code: '9999', name: null, description: null }]],
      [null, []],
    ]);
  });

  it("the address is the latest record's published address", async () => {
    const { session } = await account();
    const profile = await open(session, fx.firms.zarfeen);
    const [latest] = await t.db.select().from(fdaRefusal).where(eq(fdaRefusal.id, profile.refusals[0].id));
    expect(profile.address).toEqual({
      line: latest.addressLine1,
      city: latest.city,
      region: latest.region,
      postalCode: latest.postalCode,
      countryCode: latest.countryCode,
    });
    expect(profile.address.line).toBe('12 Industrial Estate, Kot Lakhpat');
    // The published form, not the normalised `firm.city`.
    expect(profile.address.city).toBe('Lahore');
  });

  it('the address joins both lines FDA publishes', async () => {
    const { session } = await account();
    const firmId = await insertFirm(t.db, { displayName: 'Two Line Foods', countryCode: 'IN' });
    await insertRefusal(t.db, {
      firmId,
      addressLine1: 'Plot 4',
      addressLine2: 'MIDC Area',
      city: 'Pune',
      region: 'Maharashtra',
      postalCode: '411019',
      countryCode: 'IN',
    });
    expect((await open(session, firmId)).address).toEqual({
      line: 'Plot 4, MIDC Area',
      city: 'Pune',
      region: 'Maharashtra',
      postalCode: '411019',
      countryCode: 'IN',
    });
  });

  it('a firm without a published address falls back to its own country and region', async () => {
    const { session } = await account();
    const firmId = await insertFirm(t.db, { displayName: 'Addressless Foods', countryCode: 'VN', region: 'Hanoi', city: 'hanoi', postalCode: '100000' });
    expect((await open(session, firmId)).address).toEqual({ line: null, city: null, region: 'Hanoi', postalCode: '100000', countryCode: 'VN' });
  });

  it('a merged-away id answers with the survivor, and the lookup is charged to it', async () => {
    const { session, orgId } = await account();
    const profile = await open(session, fx.firms.mergedAway);
    expect(profile.id).toBe(fx.firms.zarfeen);
    const log = await t.db.select().from(lookupLog).where(eq(lookupLog.orgId, orgId));
    expect(log.map((row) => row.firmId)).toEqual([fx.firms.zarfeen]);
    // The same firm by its other id is the same lookup.
    expect((await open(session, fx.firms.zarfeen)).lookup).toMatchObject({ charged: false, used: 1 });
  });

  it('lookups: the first view is charged, the second is not', async () => {
    const { session } = await account();
    expect((await open(session, fx.firms.zarfeen)).lookup).toEqual({ charged: true, used: 1, limit: 200 });
    expect((await open(session, fx.firms.zarfeen)).lookup).toEqual({ charged: false, used: 1, limit: 200 });
    expect((await open(session, fx.firms.alRahmanLahore)).lookup).toEqual({ charged: true, used: 2, limit: 200 });
  });

  it('unverified users are refused, and no lookup is used', async () => {
    const unverified = t.session();
    await unverified
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: 'unverified@firm-profile.test', password: 'zarfeen-rice-2026', companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await unverified.post('/v1/auth/login').send({ email: 'unverified@firm-profile.test', password: 'zarfeen-rice-2026' }).expect(200);
    const before = { lookups: await t.db.select().from(lookupLog), usage: await t.db.select().from(usageCounter) };
    const res = await unverified.get(`/v1/firms/${fx.firms.zarfeen}`).expect(403);
    expect((res.body as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
    expect({ lookups: await t.db.select().from(lookupLog), usage: await t.db.select().from(usageCounter) }).toEqual(before);
  });

  it("a free account's 11th firm is refused, and stays unopened", async () => {
    const { session, orgId } = await account('free');
    const ids: number[] = [];
    for (let i = 0; i < 11; i++) ids.push(await insertFirm(t.db, { displayName: `Limit Test Foods ${n}-${i}`, countryCode: 'PK' }));
    for (const id of ids.slice(0, 10)) await open(session, id);
    const res = await session.get(`/v1/firms/${ids[10]}`).expect(403);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'lookup', plan: 'free', limit: 10, used: 10 } });
    const logged = (await t.db.select().from(lookupLog).where(eq(lookupLog.orgId, orgId))).map((r) => r.firmId);
    expect(logged.sort()).toEqual(ids.slice(0, 10).sort());
    // A firm already opened this month is still open to the account.
    expect((await open(session, ids[0])).lookup.charged).toBe(false);
  });

  it('404 for an unknown firm, with no lookup used', async () => {
    const { session, orgId } = await account();
    const res = await session.get('/v1/firms/987654321').expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
    await session.get('/v1/firms/abc').expect(404);
    await session.get('/v1/firms/0').expect(404);
    expect(await t.db.select().from(lookupLog).where(eq(lookupLog.orgId, orgId))).toEqual([]);
    expect(await t.db.select().from(usageCounter).where(eq(usageCounter.orgId, orgId))).toEqual([]);
  });

  it('needs a session', async () => {
    await t.session().get(`/v1/firms/${fx.firms.zarfeen}`).expect(401);
  });

  it('a firm whose facts are not yet refreshed answers with empty ones', async () => {
    const { session } = await account();
    const firmId = await insertFirm(t.db, { displayName: 'Brand New Foods' });
    const profile = await open(session, firmId);
    expect(profile.facts).toEqual({
      import_alert_red: [],
      import_alert_green: [],
      fda_refusals_12m: 0,
      fda_refusals_3y: 0,
      au_failed_3y: 0,
      au_holding_order: false,
      top_hazards_3y: [],
    });
    expect(profile).toMatchObject({ refusals: [], listings: [], auFailures: [], feis: [], firstSeen: null, lastNoticeOn: null });
  });

  it("a profile view writes only the caller's own lookup rows", async () => {
    const a = await account();
    const b = await account();
    await open(a.session, fx.firms.zarfeen);
    expect(await t.db.select().from(lookupLog).where(eq(lookupLog.orgId, a.orgId))).toHaveLength(1);
    expect(await t.db.select().from(usageCounter).where(eq(usageCounter.orgId, a.orgId))).toHaveLength(1);
    expect(await t.db.select().from(lookupLog).where(eq(lookupLog.orgId, b.orgId))).toEqual([]);
    expect(await t.db.select().from(usageCounter).where(eq(usageCounter.orgId, b.orgId))).toEqual([]);
  });

  it('no banned words', async () => {
    const { session } = await account();
    const profile = await open(session, fx.firms.zarfeen);
    // Text that comes from the agency is the agency's own words; the rest is ours.
    const ours = { ...profile, refusals: [], listings: [], auFailures: [] };
    expect(JSON.stringify(ours)).not.toMatch(/\b(clean|safe|banned|blacklisted|unsafe|fraud)\b/i);
  });

  describe('for the watchlist', () => {
    it('resolveId follows an alias, keeps a survivor and finds nothing for an unknown id', async () => {
      const profiles = t.app.get(FirmProfileService);
      expect(await profiles.resolveId(fx.firms.mergedAway)).toBe(fx.firms.zarfeen);
      expect(await profiles.resolveId(fx.firms.zarfeen)).toBe(fx.firms.zarfeen);
      expect(await profiles.resolveId(987654321)).toBeNull();
    });

    it('summaryFacts gives the facts of the firms named, and uses no lookup', async () => {
      const profiles = t.app.get(FirmProfileService);
      const before = await t.db.select().from(lookupLog);
      const facts = await profiles.summaryFacts([fx.firms.zarfeen, fx.firms.alRahmanLahore, 987654321]);
      expect([...facts.keys()].sort()).toEqual([fx.firms.zarfeen, fx.firms.alRahmanLahore].sort());
      expect(facts.get(fx.firms.zarfeen)).toMatchObject({
        displayName: 'ZARFEEN RICE MILLS (PVT) LTD',
        countryCode: 'PK',
        lastNoticeOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        facts: { fda_refusals_12m: 1, au_holding_order: true },
      });
      expect(facts.get(fx.firms.alRahmanLahore)?.facts.fda_refusals_3y).toBe(0);
      expect(await profiles.summaryFacts([])).toEqual(new Map());
      expect(await t.db.select().from(lookupLog)).toEqual(before);
    });
  });
});
