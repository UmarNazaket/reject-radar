import type { ImportAlertSummaryContent } from '@rejectradar/contracts';
import { type Database, importAlert, importAlertSummary, prepareTestDatabase } from '@rejectradar/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { openDb } from '../core/db';
import { draftSummaries } from './draft';
import type { GenerateJson } from './gemini';
import { translateSummaries } from './translate';

const SHA = 'a'.repeat(64);
const OLD_SHA = 'b'.repeat(64);

const content = (tag: string): ImportAlertSummaryContent => ({
  summary: `FDA may detain these foods (${tag}).`,
  whatTriggersListing: `Residues above the limit (${tag}).`,
  howFirmsGetRemoved: `Five clean shipments (${tag}).`,
  testsMentioned: ['Pesticide residue analysis'],
});

describe('Import Alert summaries', () => {
  let handle: ReturnType<typeof openDb>;
  let db: Database;
  let generateJson: jest.Mock<ReturnType<GenerateJson>, Parameters<GenerateJson>>;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_summaries'));
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate import_alert cascade`);
    generateJson = jest.fn<ReturnType<GenerateJson>, Parameters<GenerateJson>>().mockImplementation(async ({ system }) => content(system.includes('Translate') ? 'translated' : 'drafted'));
  });

  const alert = (number: string, extra: Partial<typeof importAlert.$inferInsert> = {}) =>
    db.insert(importAlert).values({
      number,
      title: `Alert ${number}`,
      isFood: true,
      reasonText: `Reason of ${number}`,
      chargeText: `Charge of ${number}`,
      textSha256: SHA,
      url: `https://www.accessdata.fda.gov/cms_ia/importalert_${number}.html`,
      ...extra,
    });
  const summary = (alertNumber: string, locale: string, status: string, sourceSha256 = SHA) =>
    db.insert(importAlertSummary).values({ alertNumber, locale, status, sourceSha256, content: content('stored'), model: 'old-model', reviewedAt: status === 'approved' ? new Date() : null });
  const rows = () =>
    db
      .select({ alertNumber: importAlertSummary.alertNumber, locale: importAlertSummary.locale, status: importAlertSummary.status, sourceSha256: importAlertSummary.sourceSha256, model: importAlertSummary.model, reviewedAt: importAlertSummary.reviewedAt })
      .from(importAlertSummary)
      .orderBy(asc(importAlertSummary.alertNumber), asc(importAlertSummary.locale));
  const deps = () => ({ db, model: 'gemini-test', generateJson });

  describe('summaries:draft', () => {
    it('drafts food alerts with no English summary of their current text', async () => {
      await alert('10-01');
      await alert('10-02');
      await summary('10-02', 'en', 'approved', OLD_SHA); // text changed since
      await alert('10-03');
      await summary('10-03', 'en', 'draft'); // waiting for review
      await alert('10-04');
      await summary('10-04', 'en', 'rejected'); // rejected for this text
      await alert('10-05', { isFood: false });
      await alert('10-06', { removedAt: new Date() });

      expect(await draftSummaries(deps(), { limit: 20 })).toEqual({ drafted: ['10-01', '10-02'], invalid: [], failed: [] });
      const stored = await rows();
      expect(stored.filter((r) => r.alertNumber === '10-01' || r.alertNumber === '10-02')).toEqual([
        { alertNumber: '10-01', locale: 'en', status: 'draft', sourceSha256: SHA, model: 'gemini-test', reviewedAt: null },
        { alertNumber: '10-02', locale: 'en', status: 'draft', sourceSha256: SHA, model: 'gemini-test', reviewedAt: null },
      ]);
      const [drafted] = await db.select({ content: importAlertSummary.content }).from(importAlertSummary).where(eq(importAlertSummary.alertNumber, '10-01'));
      expect(drafted.content).toEqual(content('drafted'));
    });

    it('sends only the alert text', async () => {
      await alert('10-01', { guidanceText: null, productText: 'Basmati rice' });
      await draftSummaries(deps(), { limit: 20 });
      const [{ system, prompt, schema }] = generateJson.mock.calls[0];
      expect(prompt).toBe('Import Alert 10-01: Alert 10-01\n\nReason for alert:\nReason of 10-01\n\nProduct description:\nBasmati rice\n\nCharge:\nCharge of 10-01');
      expect(system).toContain('Use only the alert text');
      expect(schema).toMatchObject({ type: 'OBJECT', required: ['summary', 'whatTriggersListing', 'howFirmsGetRemoved', 'testsMentioned'] });
    });

    it('asks again once when an answer fails the schema, then gives up on that alert', async () => {
      await alert('10-01');
      await alert('10-02');
      const tooLong = { ...content('x'), summary: Array.from({ length: 121 }, () => 'word').join(' ') };
      generateJson
        .mockResolvedValueOnce(tooLong)
        .mockResolvedValueOnce(content('second try'))
        .mockResolvedValueOnce({ summary: 'only one field' })
        .mockResolvedValueOnce(tooLong);
      expect(await draftSummaries(deps(), { limit: 20 })).toEqual({ drafted: ['10-01'], invalid: ['10-02'], failed: [] });
      expect((await rows()).map((r) => r.alertNumber)).toEqual(['10-01']);
    });

    it('a failed call ends the run; the rest wait for the next one', async () => {
      await alert('10-01');
      await alert('10-02');
      generateJson.mockRejectedValueOnce(new Error('Gemini answered HTTP 503'));
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await draftSummaries(deps(), { limit: 20 })).toEqual({ drafted: [], invalid: [], failed: ['10-01'] });
      expect(errors).toHaveBeenCalledWith('summaries:draft: 10-01: Gemini answered HTTP 503');
      expect(generateJson).toHaveBeenCalledTimes(1);
      errors.mockRestore();
      expect((await draftSummaries(deps(), { limit: 20 })).drafted).toEqual(['10-01', '10-02']);
    });

    it('keeps to the limit and to --only', async () => {
      for (const number of ['10-01', '10-02', '10-03']) await alert(number);
      expect((await draftSummaries(deps(), { limit: 2 })).drafted).toEqual(['10-01', '10-02']);
      expect((await draftSummaries(deps(), { limit: 20, only: ['10-03', '99-99'] })).drafted).toEqual(['10-03']);
    });

    it('a new draft replaces an approved summary of older text and clears its review', async () => {
      await alert('10-01');
      await summary('10-01', 'en', 'approved', OLD_SHA);
      await draftSummaries(deps(), { limit: 20 });
      expect(await rows()).toEqual([{ alertNumber: '10-01', locale: 'en', status: 'draft', sourceSha256: SHA, model: 'gemini-test', reviewedAt: null }]);
    });
  });

  describe('summaries:translate', () => {
    it('translates approved English of the current text into each other language once', async () => {
      await alert('10-01');
      await summary('10-01', 'en', 'approved');
      await summary('10-01', 'ur', 'machine'); // already done
      await alert('10-02');
      await summary('10-02', 'en', 'approved', OLD_SHA); // English of older text
      await alert('10-03');
      await summary('10-03', 'en', 'draft');
      await alert('10-04');
      await summary('10-04', 'en', 'approved');
      await summary('10-04', 'hi', 'machine', OLD_SHA); // translation of older text

      expect(await translateSummaries(deps(), { limit: 30 })).toEqual({
        translated: ['10-01 (bn)', '10-01 (hi)', '10-04 (bn)', '10-04 (hi)', '10-04 (ur)'],
        invalid: [],
        failed: [],
      });
      const machine = (await rows()).filter((r) => r.status === 'machine' && r.model === 'gemini-test');
      expect(machine.map((r) => `${r.alertNumber} ${r.locale} ${r.sourceSha256 === SHA}`)).toEqual(['10-01 bn true', '10-01 hi true', '10-04 bn true', '10-04 hi true', '10-04 ur true']);
      expect(await translateSummaries(deps(), { limit: 30 })).toEqual({ translated: [], invalid: [], failed: [] });
    });

    it('sends the English content and names the language', async () => {
      await alert('10-01');
      await summary('10-01', 'en', 'approved');
      await translateSummaries(deps(), { limit: 1 });
      expect(generateJson).toHaveBeenCalledTimes(1);
      const [{ system, prompt }] = generateJson.mock.calls[0];
      expect(system).toContain('into Bengali');
      expect(JSON.parse(prompt)).toEqual(content('stored'));
    });

    it('a translation that fails the schema twice is left for the next run', async () => {
      await alert('10-01');
      await summary('10-01', 'en', 'approved');
      generateJson.mockResolvedValueOnce({ summary: '' }).mockResolvedValueOnce({ summary: '' });
      expect(await translateSummaries(deps(), { limit: 3 })).toEqual({ translated: ['10-01 (hi)', '10-01 (ur)'], invalid: ['10-01 (bn)'], failed: [] });
      const [bn] = await db.select().from(importAlertSummary).where(and(eq(importAlertSummary.alertNumber, '10-01'), eq(importAlertSummary.locale, 'bn')));
      expect(bn).toBeUndefined();
    });
  });
});
