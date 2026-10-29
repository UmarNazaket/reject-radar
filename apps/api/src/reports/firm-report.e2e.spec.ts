import { lookupLog, usageCounter } from '@rejectradar/db';
import { insertAuRow, insertFirm, insertListing, insertRefusal, refreshFirmAggregates } from '@rejectradar/entities';
import { eq } from 'drizzle-orm';
import type { Response } from 'supertest';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { daysAgo, type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';
import { FirmReportService } from './firm-report.service';
import { PDF_COPY } from './pdf-copy';
import { pageCount, textOf } from './pdf-test-utils';

/** supertest keeps a body it has no parser for as text; a PDF is read as raw bytes instead. */
const binary = (res: Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('firm report PDF', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let eightOfEach: number;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_firm_report');
    fx = await seedReferenceData(t.db);
    eightOfEach = await insertFirm(t.db, { displayName: 'Eight Of Each Foods Ltd', countryCode: 'PK', city: 'karachi' });
    for (let i = 1; i <= 8; i++) {
      await insertRefusal(t.db, {
        firmId: eightOfEach,
        firmName: 'Eight Of Each Foods Ltd',
        productDesc: `Refused lot number ${i}`,
        refusalDate: daysAgo(i * 20),
        chargeCodes: ['2561'],
        fdaSampleAnalysis: true,
        countryCode: 'PK',
      });
      await insertListing(t.db, {
        firmId: eightOfEach,
        firmName: 'Eight Of Each Foods Ltd',
        alertNumber: `66-${String(i).padStart(2, '0')}`,
        listedOn: daysAgo(i * 30),
        firstSeenOn: daysAgo(i * 30),
        countryCode: 'PK',
      });
      await insertAuRow(t.db, {
        firmId: eightOfEach,
        producerName: 'Eight Of Each Foods Ltd',
        productDesc: `Australian sample number ${i}`,
        failedOn: daysAgo(i * 25),
        reportMonth: `${daysAgo(i * 25).slice(0, 7)}-01`,
        countryCode: 'PK',
      });
    }
    await refreshFirmAggregates(t.db, { today: daysAgo(0), firmIds: [eightOfEach] });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  /** A verified account of its own, so lookups never carry over between specs. */
  async function account(plan: 'free' | 'pro' = 'pro', company = `Report Company ${n + 1}`) {
    n += 1;
    const who = await signUpVerified(t, { email: `user${n}@firm-report.test`, company });
    if (plan !== 'free') await setPlan(t, who.orgId, plan);
    return { ...who, company };
  }

  const lookups = async (orgId: string) => (await t.app.get(EntitlementsService).usage(orgId)).lookups;
  const getPdf = (session: TestSession, id: number | string) => session.get(`/v1/firms/${id}/report.pdf`).buffer(true).parse(binary);

  it('answers a Pro account with the PDF as an attachment, and charges one lookup', async () => {
    const { session, orgId } = await account();
    const res = await getPdf(session, fx.firms.zarfeen).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="rejectradar-firm-${fx.firms.zarfeen}.pdf"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
    expect(await lookups(orgId)).toBe(1);
  });

  it('refuses a Free account with PLAN_UPGRADE_REQUIRED and charges nothing', async () => {
    const { session, orgId } = await account('free');
    const res = await session.get(`/v1/firms/${fx.firms.zarfeen}/report.pdf`).expect(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', details: { feature: 'pdf', plan: 'free' } });
    expect(await lookups(orgId)).toBe(0);
    expect(await t.db.select().from(lookupLog).where(eq(lookupLog.orgId, orgId))).toEqual([]);
  });

  it('charges one lookup in total for a profile and then its PDF in one month', async () => {
    const { session, orgId } = await account();
    await session.get(`/v1/firms/${fx.firms.zarfeen}`).expect(200);
    await getPdf(session, fx.firms.zarfeen).expect(200);
    await getPdf(session, fx.firms.zarfeen).expect(200);
    expect(await lookups(orgId)).toBe(1);
  });

  it('with the lookups used up, serves a firm already opened and refuses a new one', async () => {
    const { session, orgId } = await account();
    await session.get(`/v1/firms/${fx.firms.zarfeen}`).expect(200);
    await t.db.update(usageCounter).set({ lookups: 200 }).where(eq(usageCounter.orgId, orgId));
    await getPdf(session, fx.firms.zarfeen).expect(200);
    const res = await session.get(`/v1/firms/${fx.firms.alRahmanLahore}/report.pdf`).expect(403);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'lookup', plan: 'pro', limit: 200, used: 200 } });
    expect(await lookups(orgId)).toBe(200);
  });

  it("gives a merged-away id the surviving firm's report, named after the survivor", async () => {
    const { session } = await account();
    const res = await getPdf(session, fx.firms.mergedAway).expect(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="rejectradar-firm-${fx.firms.zarfeen}.pdf"`);
  });

  it('404s an unknown firm and a malformed id as JSON, charging nothing', async () => {
    const { session, orgId } = await account();
    for (const id of ['999999999', 'abc', '0']) {
      const res = await session.get(`/v1/firms/${id}/report.pdf`).expect(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await lookups(orgId)).toBe(0);
  });

  it('refuses an unverified user and charges nothing', async () => {
    const unverified = t.session();
    await unverified
      .post('/v1/auth/signup')
      .send({
        name: 'Unverified',
        email: 'unverified@firm-report.test',
        password: 'zarfeen-rice-2026',
        companyName: 'Unverified Foods',
        locale: 'en',
      })
      .expect(202);
    await unverified.post('/v1/auth/login').send({ email: 'unverified@firm-report.test', password: 'zarfeen-rice-2026' }).expect(200);
    const before = await t.db.select().from(lookupLog);
    const res = await unverified.get(`/v1/firms/${fx.firms.zarfeen}/report.pdf`).expect(403);
    expect(res.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(await t.db.select().from(lookupLog)).toEqual(before);
  });

  it('refuses a caller without a session', async () => {
    await t.session().get(`/v1/firms/${fx.firms.zarfeen}/report.pdf`).expect(401);
  });

  it('keeps the profile and the report on their own routes', async () => {
    const { session } = await account();
    const profile = await session.get(`/v1/firms/${fx.firms.zarfeen}`).expect(200);
    expect(profile.headers['content-type']).toMatch(/application\/json/);
    expect(profile.body).toMatchObject({ id: fx.firms.zarfeen, displayName: 'ZARFEEN RICE MILLS (PVT) LTD' });
    const report = await getPdf(session, fx.firms.zarfeen).expect(200);
    expect(report.headers['content-type']).toBe('application/pdf');
    // The search route is still ahead of both.
    await session.get('/v1/firms/search').query({ name: 'Zarfeen', country: 'PK' }).expect(200);
  });

  it("builds the document from the caller's own account name and the firm's profile", async () => {
    const { orgId } = await account('pro', 'Indus Valley Agro Exports');
    const other = await account('pro', 'Some Other Company');
    const { doc, profile } = await t.app.get(FirmReportService).document({ orgId }, eightOfEach);
    const text = textOf(doc).join('\n');
    expect(text).toContain('Indus Valley Agro Exports');
    expect(text).not.toContain(other.company);
    expect(text).toContain('Eight Of Each Foods Ltd');
    expect(text).toContain(PDF_COPY.disclaimer);
    expect(text).not.toMatch(/\b(clean|safe)\b/i);
    // 8 refusals on file, 5 shown.
    expect(profile.refusals).toHaveLength(8);
    expect(profile.refusals.filter((r) => text.includes(r.productDesc ?? ''))).toHaveLength(5);
  });

  it('puts the firm with 8 refusals, 8 listings and 8 Australian records on one page', async () => {
    const { session } = await account();
    const res = await getPdf(session, eightOfEach).expect(200);
    expect(pageCount(res.body as Buffer)).toBe(1);
  });

  it('does not compress under NODE_ENV=test, so the page count can be read', async () => {
    const { session } = await account();
    const res = await getPdf(session, eightOfEach).expect(200);
    expect((res.body as Buffer).toString('latin1')).not.toContain('/FlateDecode');
  });

  it("charges the lookup to the caller's account only", async () => {
    const a = await account();
    const b = await account();
    await getPdf(a.session, fx.firms.zarfeen).expect(200);
    expect(await lookups(a.orgId)).toBe(1);
    expect(await lookups(b.orgId)).toBe(0);
  });
});
