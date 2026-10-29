import type { ImportAlertResponse, SummaryReviewItem, SummaryReviewResponse } from '@rejectradar/contracts';
import { appUser, auditLog, importAlert, importAlertSummary } from '@rejectradar/db';
import { asc, eq } from 'drizzle-orm';
import { seedReferenceData, summaryContent } from '../testing/reference-data';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

const SHA = 'a'.repeat(64);

describe('Import Alert summary review', () => {
  let t: TestApp;
  let admin: TestSession;
  let adminId: string;
  let user: TestSession;

  beforeAll(async () => {
    t = await startTestApp('api_summary_review');
    await seedReferenceData(t.db);
    ({ session: admin, userId: adminId } = await signUpVerified(t, { email: 'staff@rejectradar.test' }));
    await t.db.update(appUser).set({ isPlatformAdmin: true }).where(eq(appUser.id, adminId));
    ({ session: user } = await signUpVerified(t, { email: 'customer@review.test' }));
  });

  afterAll(async () => {
    await t.close();
  });

  // 16-131 starts each case as seeded: an English draft and an Urdu machine summary of its current text.
  beforeEach(async () => {
    t.resetRateLimits();
    await t.db.update(importAlert).set({ textSha256: SHA }).where(eq(importAlert.number, '16-131'));
    await t.db.delete(importAlertSummary).where(eq(importAlertSummary.alertNumber, '16-131'));
    await t.db.insert(importAlertSummary).values(
      ['en', 'ur'].map((locale) => ({ alertNumber: '16-131', locale, status: locale === 'en' ? 'draft' : 'machine', sourceSha256: SHA, content: summaryContent(locale), model: 'fixture' })),
    );
  });

  const decide = (body: object, number = '16-131') => admin.patch(`/v1/admin/import-alert-summaries/${number}`).send(body);
  const served = async (locale = 'en') => ((await user.get(`/v1/import-alerts/16-131?locale=${locale}`).expect(200)).body as ImportAlertResponse).summary;
  const locales = async () =>
    (await t.db.select({ locale: importAlertSummary.locale }).from(importAlertSummary).where(eq(importAlertSummary.alertNumber, '16-131')).orderBy(asc(importAlertSummary.locale))).map(
      (row) => row.locale,
    );

  it('is for platform admins only', async () => {
    expect((await user.get('/v1/admin/import-alert-summaries').expect(403)).body).toMatchObject({ code: 'FORBIDDEN' });
    await user.patch('/v1/admin/import-alert-summaries/16-131').send({ action: 'approve' }).expect(403);
  });

  it('lists the drafts beside their alert text', async () => {
    const { items } = (await admin.get('/v1/admin/import-alert-summaries').expect(200)).body as SummaryReviewResponse;
    expect(items).toEqual([
      expect.objectContaining({ number: '16-131', status: 'draft', current: true, content: summaryContent('en'), model: 'fixture', reasonText: 'FDA has found unapproved drug residues in fish.', reviewedBy: null }),
    ]);
    const approved = (await admin.get('/v1/admin/import-alert-summaries?status=approved').expect(200)).body as SummaryReviewResponse;
    expect(approved.items.map((item) => item.number)).toEqual(['99-08']);
  });

  it('approving serves the summary and drops the old translations', async () => {
    expect(await served()).toBeNull();
    const item = (await decide({ action: 'approve' }).expect(200)).body as SummaryReviewItem;
    expect(item).toMatchObject({ number: '16-131', status: 'approved', reviewedBy: adminId, reviewedAt: expect.any(String) });
    expect(await served()).toEqual({ locale: 'en', status: 'approved', content: summaryContent('en') });
    expect(await locales()).toEqual(['en']);
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.targetId, '16-131'));
    expect(audit).toMatchObject({ actorUserId: adminId, action: 'import_alert_summary.approved', details: { edited: false } });
  });

  it('approves corrected content, held to the English schema', async () => {
    const corrected = { ...summaryContent('en'), summary: 'FDA may detain fish with unapproved drug residues.' };
    await decide({ action: 'approve', content: corrected }).expect(200);
    expect((await served())?.content).toEqual(corrected);

    const tooLong = { ...corrected, summary: Array.from({ length: 121 }, () => 'word').join(' ') };
    expect((await decide({ action: 'approve', content: tooLong }).expect(400)).body).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a summary of text FDA has since changed cannot be approved, but can be rejected', async () => {
    await t.db.update(importAlert).set({ textSha256: 'c'.repeat(64) }).where(eq(importAlert.number, '16-131'));
    expect((await decide({ action: 'approve' }).expect(409)).body).toMatchObject({ code: 'SUMMARY_STALE' });
    expect((await decide({ action: 'reject' }).expect(200)).body).toMatchObject({ status: 'rejected', current: false });
  });

  it('a rejected summary is not served', async () => {
    await decide({ action: 'approve' }).expect(200);
    await decide({ action: 'reject' }).expect(200);
    expect(await served()).toBeNull();
  });

  it('an alert without an English summary answers 404, and a malformed number 400', async () => {
    await t.db.delete(importAlertSummary).where(eq(importAlertSummary.alertNumber, '16-131'));
    await decide({ action: 'approve' }).expect(404);
    await decide({ action: 'approve' }, 'xx').expect(400);
    await decide({ action: 'publish' }).expect(400);
  });
});
