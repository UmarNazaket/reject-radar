import {
  type ImportAlertResponse,
  importAlertEnglishSummaryContentSchema,
  importAlertSummaryContentSchema,
  SUMMARY_MAX_WORDS,
} from '@rejectradar/contracts';
import { importAlert, importAlertSummary } from '@rejectradar/db';
import { and, eq } from 'drizzle-orm';
import { seedReferenceData, summaryContent } from '../testing/reference-data';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('Import Alert endpoint', () => {
  let t: TestApp;
  let session: TestSession;

  beforeAll(async () => {
    t = await startTestApp('api_import_alerts');
    await seedReferenceData(t.db);
    session = (await signUpVerified(t, { email: 'user@alerts.test' })).session;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const get = async (number: string, query = ''): Promise<ImportAlertResponse> =>
    (await session.get(`/v1/import-alerts/${number}${query}`).expect(200)).body as ImportAlertResponse;
  const setSummary = (number: string, locale: string, set: Partial<typeof importAlertSummary.$inferInsert>) =>
    t.db
      .update(importAlertSummary)
      .set(set)
      .where(and(eq(importAlertSummary.alertNumber, number), eq(importAlertSummary.locale, locale)));
  const setAlert = (number: string, set: Partial<typeof importAlert.$inferInsert>) =>
    t.db.update(importAlert).set(set).where(eq(importAlert.number, number));

  it('serves the alert text', async () => {
    const res = await get('99-08');
    expect(res).toMatchObject({
      number: '99-08',
      alertType: 'DWPE',
      publishedOn: '2023-05-02',
      url: 'https://www.accessdata.fda.gov/cms_ia/importalert_99-08.html',
      removed: false,
      reasonText: expect.stringContaining('pesticide residues'),
    });
    expect(res.title).toContain('Detention Without Physical Examination');
  });

  it('English approved is served', async () => {
    const res = await get('99-08', '?locale=en');
    expect(res.summary).toEqual({ locale: 'en', status: 'approved', content: summaryContent('en') });
  });

  it('English is the default locale', async () => {
    expect((await get('99-08')).summary).toMatchObject({ locale: 'en', status: 'approved' });
  });

  it('machine translation is served and labelled', async () => {
    const res = await get('99-08', '?locale=ur');
    expect(res.summary).toEqual({ locale: 'ur', status: 'machine', content: summaryContent('ur') });
  });

  it('a draft translation falls back to English', async () => {
    expect((await get('99-08', '?locale=hi')).summary).toMatchObject({ locale: 'en', status: 'approved' });
  });

  it('a stale summary is never served', async () => {
    const res = await get('99-08', '?locale=bn');
    expect(res.summary).toEqual({ locale: 'en', status: 'approved', content: summaryContent('en') });
  });

  it('no translation without an approved English summary', async () => {
    // 16-131 has an English draft and an Urdu machine summary of the current text (P5-D11).
    expect((await get('16-131', '?locale=ur')).summary).toBeNull();
    expect((await get('16-131', '?locale=en')).summary).toBeNull();
  });

  it('rejected is never served, and hides the translations behind it', async () => {
    await setSummary('99-08', 'en', { status: 'rejected' });
    try {
      expect((await get('99-08', '?locale=en')).summary).toBeNull();
      expect((await get('99-08', '?locale=ur')).summary).toBeNull();
    } finally {
      await setSummary('99-08', 'en', { status: 'approved' });
    }
  });

  it('a rejected translation is not served; English is', async () => {
    await setSummary('99-08', 'ur', { status: 'rejected' });
    try {
      expect((await get('99-08', '?locale=ur')).summary).toMatchObject({ locale: 'en' });
    } finally {
      await setSummary('99-08', 'ur', { status: 'machine' });
    }
  });

  it('summaries are hidden when the alert text changes', async () => {
    await setAlert('99-08', { textSha256: 'c'.repeat(64) });
    try {
      const res = await get('99-08', '?locale=en');
      expect(res.summary).toBeNull();
      expect(res.reasonText).toContain('pesticide residues');
    } finally {
      await setAlert('99-08', { textSha256: 'a'.repeat(64) });
    }
  });

  it('content that fails the schema is not served', async () => {
    const withoutSummary = summaryContent('en');
    delete withoutSummary['summary'];
    await setSummary('99-08', 'en', { content: withoutSummary });
    try {
      expect((await get('99-08', '?locale=en')).summary).toBeNull();
    } finally {
      await setSummary('99-08', 'en', { content: summaryContent('en') });
    }
  });

  it('a translation that fails the schema falls back to English', async () => {
    await setSummary('99-08', 'ur', { content: { summary: 'x' } });
    try {
      expect((await get('99-08', '?locale=ur')).summary).toMatchObject({ locale: 'en' });
    } finally {
      await setSummary('99-08', 'ur', { content: summaryContent('ur') });
    }
  });

  it('a long translation behind an approved English summary is served', async () => {
    const long = { ...summaryContent('ur'), summary: Array.from({ length: 130 }, () => 'lafz').join(' ') };
    await setSummary('99-08', 'ur', { content: long });
    try {
      expect((await get('99-08', '?locale=ur')).summary).toEqual({ locale: 'ur', status: 'machine', content: long });
    } finally {
      await setSummary('99-08', 'ur', { content: summaryContent('ur') });
    }
  });

  it('an English summary over the word limit is not served', async () => {
    await setSummary('99-08', 'en', { content: { ...summaryContent('en'), summary: Array.from({ length: SUMMARY_MAX_WORDS + 1 }, () => 'word').join(' ') } });
    try {
      expect((await get('99-08', '?locale=ur')).summary).toBeNull();
    } finally {
      await setSummary('99-08', 'en', { content: summaryContent('en') });
    }
  });

  it('a removed alert says so', async () => {
    await setAlert('99-08', { removedAt: new Date() });
    try {
      expect((await get('99-08')).removed).toBe(true);
    } finally {
      await setAlert('99-08', { removedAt: null });
    }
  });

  it('unknown alert is 404, a bad number or locale is 400', async () => {
    await session.get('/v1/import-alerts/00-00').expect(404);
    await session.get('/v1/import-alerts/9-08').expect(400);
    await session.get('/v1/import-alerts/99-8').expect(400);
    await session.get('/v1/import-alerts/99-1234').expect(400);
    await session.get('/v1/import-alerts/abc').expect(400);
    await session.get('/v1/import-alerts/99-08?locale=fr').expect(400);
  });

  it('requires a session', async () => {
    await t.session().get('/v1/import-alerts/99-08').expect(401);
  });
});

describe('importAlertSummaryContentSchema', () => {
  const content = summaryContent('x');
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

  it('English accepts 120 words and refuses 121', () => {
    expect(importAlertEnglishSummaryContentSchema.safeParse({ ...content, summary: words(SUMMARY_MAX_WORDS) }).success).toBe(true);
    expect(importAlertEnglishSummaryContentSchema.safeParse({ ...content, summary: words(SUMMARY_MAX_WORDS + 1) }).success).toBe(false);
  });

  it('the base shape has no word limit', () => {
    expect(importAlertSummaryContentSchema.safeParse({ ...content, summary: words(130) }).success).toBe(true);
  });

  it('refuses an empty field and a non-array of tests', () => {
    expect(importAlertSummaryContentSchema.safeParse({ ...content, whatTriggersListing: '' }).success).toBe(false);
    expect(importAlertSummaryContentSchema.safeParse({ ...content, testsMentioned: 'x' }).success).toBe(false);
  });
});
