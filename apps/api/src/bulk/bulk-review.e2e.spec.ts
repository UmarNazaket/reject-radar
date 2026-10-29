import type { BulkJobResponse, BulkRowResponse, BulkRowsResponse, WatchConfirmedResponse } from '@rejectradar/contracts';
import { bulkJob, bulkJobRow, watchlistItem, uuidv7 } from '@rejectradar/db';
import { insertFirm, mergeFirms } from '@rejectradar/entities';
import { parse } from 'csv-parse/sync';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Response } from 'supertest';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';
import { BulkProcessor } from './bulk-processor';

const FLAGS = {
  import_alert_red: [{ alert: '99-08', listed_on: '2026-01-01' }],
  import_alert_green: [],
  fda_refusals_12m: 1,
  fda_refusals_3y: 4,
  au_failed_3y: 2,
  au_holding_order: false,
  top_hazards_3y: [],
};

interface Input {
  name: string;
  country?: string;
  city?: string;
}

/** One CSV cell, quoted when it needs it. */
const cell = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

describe('bulk review, watch confirmed and export (P6-D7 to P6-D9)', () => {
  let t: TestApp;
  let processor: BulkProcessor;
  let owner: { session: TestSession; orgId: string; userId: string };
  let n = 0;
  const firms = { zarfeen: 0, alRahmanLahore: 0, alRahmanKarachi: 0, clean: 0 };

  beforeAll(async () => {
    t = await startTestApp('api_bulk_review');
    processor = t.app.get(BulkProcessor);
    firms.zarfeen = await insertFirm(t.db, { displayName: 'Zarfeen Rice Mills', countryCode: 'PK', city: 'lahore', flags: FLAGS });
    firms.alRahmanLahore = await insertFirm(t.db, { displayName: 'Al Rahman Rice Mills', countryCode: 'PK', city: 'lahore' });
    firms.alRahmanKarachi = await insertFirm(t.db, { displayName: 'Al Rahman Rice Mills', countryCode: 'PK', city: 'karachi' });
    firms.clean = await insertFirm(t.db, { displayName: 'Basmati Plain Exporters', countryCode: 'PK', city: 'multan' });
    owner = await signUpVerified(t, { email: 'owner@bulk-review.test' });
    await setPlan(t, owner.orgId, 'business');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const csv = (rows: Input[]) =>
    ['name,country,city', ...rows.map((r) => `${cell(r.name)},${r.country ?? 'PK'},${cell(r.city ?? '')}`)].join('\r\n') + '\r\n';

  /** Uploads `rows` as `session` and waits for the job to finish. */
  const run = async (rows: Input[], session: TestSession = owner.session): Promise<string> => {
    const res = await session.post('/v1/bulk-jobs').query({ fileName: 'suppliers.csv' }).set('Content-Type', 'text/csv').send(csv(rows)).expect(202);
    await processor.idle();
    return (res.body as BulkJobResponse).id;
  };

  const rowsOf = async (jobId: string, query = '', session: TestSession = owner.session) =>
    (await session.get(`/v1/bulk-jobs/${jobId}/rows${query}`).expect(200)).body as BulkRowsResponse;

  /** A job written straight to the tables, with a fresh heartbeat so nothing resumes it, and one pending row. */
  async function seedUnfinished(): Promise<{ jobId: string; rowId: number }> {
    const jobId = uuidv7();
    await t.db.insert(bulkJob).values({
      id: jobId, orgId: owner.orgId, createdBy: owner.userId, fileName: 'pending.csv', status: 'running', total: 1, heartbeatAt: sql`now()`,
    });
    const [row] = await t.db
      .insert(bulkJobRow)
      .values({ jobId, rowNr: 1, inputName: 'Pending Supplier Ltd', inputCountry: 'PK' })
      .returning({ id: bulkJobRow.id });
    return { jobId, rowId: row.id };
  }

  const code = (res: Response) => (res.body as { code: string }).code;

  describe('GET /v1/bulk-jobs/:id/rows', () => {
    it('pages 250 rows as 100, 100 and 50, and filters by status', async () => {
      const filler = Array.from({ length: 248 }, (_, i) => ({ name: `Qzxv${i} Nomatch Holdings` }));
      const jobId = await run([{ name: 'Zarfeen Rice Mills', city: 'Lahore' }, { name: 'Al Rahman Rice Mills' }, ...filler]);

      const first = await rowsOf(jobId);
      expect(first.rows).toHaveLength(100);
      expect(first.rows[0]).toMatchObject({ rowNr: 1, status: 'matched', input: { name: 'Zarfeen Rice Mills', country: 'PK', city: 'Lahore', fei: null } });
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await rowsOf(jobId, `?cursor=${first.nextCursor}`);
      expect(second.rows).toHaveLength(100);
      expect(second.rows[0].rowNr).toBe(101);
      const third = await rowsOf(jobId, `?cursor=${second.nextCursor}`);
      expect(third.rows).toHaveLength(50);
      expect(third.rows[49].rowNr).toBe(250);
      expect(third.nextCursor).toBeNull();

      const review = await rowsOf(jobId, '?status=review');
      expect(review.rows.map((r) => r.rowNr)).toEqual([2]);
      expect(review.rows[0].candidates.map((c) => c.firmId).sort()).toEqual([firms.alRahmanLahore, firms.alRahmanKarachi].sort());
      expect(review.nextCursor).toBeNull();
      expect((await rowsOf(jobId, '?status=no_record')).rows).toHaveLength(100);
    });

    it('gives a matched row the facts of its firm, and a row without a firm none', async () => {
      const jobId = await run([{ name: 'Zarfeen Rice Mills', city: 'Lahore' }, { name: 'Basmati Plain Exporters', city: 'Multan' }, { name: 'Qzxv Nomatch Holdings' }]);
      const { rows } = await rowsOf(jobId);
      expect(rows[0]).toMatchObject({
        status: 'matched',
        firm: { id: firms.zarfeen, displayName: 'Zarfeen Rice Mills', countryCode: 'PK' },
        facts: { fdaRefusals3y: 4, importAlertRed: true, auFailed3y: 2 },
      });
      expect(rows[0].score).toBeGreaterThanOrEqual(0.9);
      expect(rows[1].facts).toEqual({ fdaRefusals3y: 0, importAlertRed: false, auFailed3y: 0 });
      expect(rows[2]).toMatchObject({ status: 'no_record', firm: null, facts: null, score: null, candidates: [] });
    });

    it('rejects an unknown status and a malformed cursor, and hides another account\'s job', async () => {
      const jobId = await run([{ name: 'Qzxv Nomatch Holdings' }]);
      await owner.session.get(`/v1/bulk-jobs/${jobId}/rows?status=clean`).expect(400);
      await owner.session.get(`/v1/bulk-jobs/${jobId}/rows?cursor=nonsense`).expect(400);
      const other = await signUpVerified(t, { email: `other${++n}@bulk-review.test` });
      const res = await other.session.get(`/v1/bulk-jobs/${jobId}/rows`).expect(404);
      expect(code(res)).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /v1/bulk-jobs/:id/rows/:rowId', () => {
    const patch = (jobId: string, rowId: number, body: object) => owner.session.patch(`/v1/bulk-jobs/${jobId}/rows/${rowId}`).send(body);

    it('confirms the second candidate of a review row', async () => {
      const jobId = await run([{ name: 'Al Rahman Rice Mills' }]);
      const [row] = (await rowsOf(jobId)).rows;
      expect(row.status).toBe('review');
      const second = row.candidates[1];
      const res = await patch(jobId, row.id, { action: 'confirm', firmId: second.firmId }).expect(200);
      const body = res.body as BulkRowResponse;
      expect(body).toMatchObject({ id: row.id, status: 'confirmed', score: second.score, firm: { id: second.firmId } });
      expect(body.facts).toEqual({ fdaRefusals3y: 0, importAlertRed: false, auFailed3y: 0 });
      expect((await rowsOf(jobId)).rows[0]).toMatchObject({ status: 'confirmed', firm: { id: second.firmId } });
    });

    it('rejects a matched row, and a decision can be changed again', async () => {
      const jobId = await run([{ name: 'Zarfeen Rice Mills', city: 'Lahore' }]);
      const [row] = (await rowsOf(jobId)).rows;
      const res = await patch(jobId, row.id, { action: 'reject' }).expect(200);
      expect(res.body).toMatchObject({ status: 'rejected', firm: null, facts: null });
      const again = await patch(jobId, row.id, { action: 'confirm', firmId: firms.zarfeen }).expect(200);
      expect(again.body).toMatchObject({ status: 'confirmed', firm: { id: firms.zarfeen } });
    });

    it('a firm that is not a candidate answers 400 NOT_A_CANDIDATE and changes nothing', async () => {
      const jobId = await run([{ name: 'Al Rahman Rice Mills' }]);
      const [row] = (await rowsOf(jobId)).rows;
      for (const firmId of [firms.clean, 2147483000]) {
        const res = await patch(jobId, row.id, { action: 'confirm', firmId }).expect(400);
        expect(code(res)).toBe('NOT_A_CANDIDATE');
      }
      expect((await rowsOf(jobId)).rows[0]).toMatchObject({ status: 'review', firm: null });
    });

    it('a pending row answers 409 ROW_PENDING', async () => {
      const { jobId, rowId } = await seedUnfinished();
      const res = await patch(jobId, rowId, { action: 'reject' }).expect(409);
      expect(code(res)).toBe('ROW_PENDING');
      const [row] = await t.db.select().from(bulkJobRow).where(eq(bulkJobRow.id, rowId));
      expect(row.status).toBe('pending');
    });

    it('a body that is neither confirm nor reject answers 400', async () => {
      const jobId = await run([{ name: 'Al Rahman Rice Mills' }]);
      const [row] = (await rowsOf(jobId)).rows;
      await patch(jobId, row.id, { action: 'confirm' }).expect(400);
      await patch(jobId, row.id, { action: 'approve' }).expect(400);
    });

    it('another account\'s row, or a row of another job, is 404', async () => {
      const jobId = await run([{ name: 'Al Rahman Rice Mills' }]);
      const [row] = (await rowsOf(jobId)).rows;
      const other = await signUpVerified(t, { email: `other${++n}@bulk-review.test` });
      await other.session.patch(`/v1/bulk-jobs/${jobId}/rows/${row.id}`).send({ action: 'reject' }).expect(404);
      const otherJob = await run([{ name: 'Qzxv Nomatch Holdings' }]);
      await patch(otherJob, row.id, { action: 'reject' }).expect(404);
      await patch(jobId, 999999999, { action: 'reject' }).expect(404);
    });

    it('after a candidate is merged away, confirming its old id confirms the surviving firm', async () => {
      const kept = await insertFirm(t.db, { displayName: 'Merge Tester Foods', countryCode: 'PK', city: 'lahore' });
      const gone = await insertFirm(t.db, { displayName: 'Merge Tester Foods', countryCode: 'PK', city: 'karachi' });
      const jobId = await run([{ name: 'Merge Tester Foods' }]);
      const [row] = (await rowsOf(jobId)).rows;
      expect(row.candidates.map((c) => c.firmId).sort()).toEqual([kept, gone]);
      await mergeFirms(t.db, { firmIds: [kept, gone], actorUserId: null, today: '2026-10-29' });

      const res = await patch(jobId, row.id, { action: 'confirm', firmId: gone }).expect(200);
      const candidate = row.candidates.find((c) => c.firmId === gone);
      expect(res.body).toMatchObject({ status: 'confirmed', score: candidate?.score, firm: { id: kept } });
      const [stored] = await t.db.select().from(bulkJobRow).where(eq(bulkJobRow.id, row.id));
      expect(stored.firmId).toBe(kept);
    });
  });

  describe('POST /v1/bulk-jobs/:id/watch-confirmed (P6-D8)', () => {
    it('adds what fits, counts the firms already watched, and names the items by the rows\' input', async () => {
      const who = await signUpVerified(t, { email: `watcher${++n}@bulk-review.test` });
      await setPlan(t, who.orgId, 'business');
      const named = ['Alpha Mills Ltd', 'Bravo Mills Ltd', 'Charlie Mills Ltd', 'Delta Mills Ltd'];
      const ids: number[] = [];
      for (const displayName of named) ids.push(await insertFirm(t.db, { displayName, countryCode: 'PK', city: 'multan' }));
      const gammaA = await insertFirm(t.db, { displayName: 'Gamma Traders Co', countryCode: 'PK', city: 'lahore' });
      await insertFirm(t.db, { displayName: 'Gamma Traders Co', countryCode: 'PK', city: 'karachi' });

      const inputs = [...named.map((name) => ({ name: name.toUpperCase(), city: 'Multan' })), { name: 'Gamma Traders Co' }, { name: 'Qzxv Nomatch Holdings' }];
      const jobId = await run(inputs, who.session);
      const [r1, r2, r3, r4, r5, r6] = (await rowsOf(jobId, '', who.session)).rows;
      expect([r1, r2, r3, r4].map((r) => r.status)).toEqual(['matched', 'matched', 'matched', 'matched']);
      expect([r5.status, r6.status]).toEqual(['review', 'no_record']);
      await who.session.patch(`/v1/bulk-jobs/${jobId}/rows/${r5.id}`).send({ action: 'confirm', firmId: gammaA }).expect(200);

      // Pro holds 25 places: 23 are taken, one of them by the second matched firm.
      await setPlan(t, who.orgId, 'pro');
      const seed = [ids[1]];
      for (let i = 0; i < 22; i++) seed.push(await insertFirm(t.db, { displayName: `Filler ${i} Foods ${'x'.repeat(i)}`, countryCode: 'IN' }));
      await t.db.insert(watchlistItem).values(seed.map((firmId) => ({ id: uuidv7(), orgId: who.orgId, kind: 'firm', firmId, addedBy: who.userId })));

      const res = await who.session.post(`/v1/bulk-jobs/${jobId}/watch-confirmed`).expect(200);
      expect(res.body as WatchConfirmedResponse).toEqual({ added: 2, alreadyWatched: 1, overLimit: 2 });
      const items = await t.db
        .select({ firmId: watchlistItem.firmId, inputName: watchlistItem.inputName })
        .from(watchlistItem)
        .where(and(eq(watchlistItem.orgId, who.orgId), sql`${watchlistItem.inputName} is not null`))
        .orderBy(asc(watchlistItem.firmId));
      expect(items).toEqual([
        { firmId: ids[0], inputName: inputs[0].name },
        { firmId: ids[2], inputName: inputs[2].name },
      ]);
      const [{ used }] = (await t.db.execute<{ used: number }>(sql`select count(*)::int as used from watchlist_item where org_id = ${who.orgId}`)).rows;
      expect(used).toBe(25);

      // Run again: nothing new fits, and the answer counts the two now watched too.
      const again = await who.session.post(`/v1/bulk-jobs/${jobId}/watch-confirmed`).expect(200);
      expect(again.body).toEqual({ added: 0, alreadyWatched: 3, overLimit: 2 });
    });

    it('answers 404 for a job of another account', async () => {
      const jobId = await run([{ name: 'Qzxv Nomatch Holdings' }]);
      const other = await signUpVerified(t, { email: `other${++n}@bulk-review.test` });
      await other.session.post(`/v1/bulk-jobs/${jobId}/watch-confirmed`).expect(404);
    });
  });

  describe('GET /v1/bulk-jobs/:id/export.csv (P6-D9)', () => {
    const exported = async (jobId: string) => {
      const res = await owner.session.get(`/v1/bulk-jobs/${jobId}/export.csv`).buffer(true).expect(200);
      return res;
    };

    it('writes the P6-D9 columns, neutralises formulas and keeps an awkward name in one row', async () => {
      const awkward = 'Line one\n"Quoted", Foods';
      const survivor = await insertFirm(t.db, { displayName: 'Survivor Foods Co', countryCode: 'PK', city: 'sialkot' });
      const matched = await insertFirm(t.db, { displayName: 'Matchable Exports Ltd', countryCode: 'PK', city: 'sialkot' });
      const jobId = await run([
        { name: '=HYPERLINK("http://x")' },
        { name: awkward },
        { name: 'Zarfeen Rice Mills', city: 'Lahore' },
        { name: 'Basmati Plain Exporters', city: 'Multan' },
        { name: 'Matchable Exports Ltd', city: 'Sialkot' },
        { name: 'Al Rahman Rice Mills' },
      ]);
      await mergeFirms(t.db, { firmIds: [survivor, matched], actorUserId: null, today: '2026-10-29' });

      const res = await exported(jobId);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="bulk-${jobId}.csv"`);
      expect(res.text.endsWith('\r\n')).toBe(true);
      const records = parse(res.text, { columns: false, skip_empty_lines: true }) as string[][];
      expect(records[0]).toEqual([
        'name', 'country', 'city', 'fei', 'status', 'score', 'firm_id', 'firm_name', 'firm_country', 'fda_refusals_3y', 'import_alert_red', 'au_failed_3y',
      ]);
      expect(records).toHaveLength(7);
      const [, formula, odd, zarfeen, plain, merged, review] = records;
      expect(formula.slice(0, 5)).toEqual([`'=HYPERLINK("http://x")`, 'PK', '', '', 'no_record']);
      expect(formula.slice(5)).toEqual(['', '', '', '', '', '', '']);
      expect(odd[0]).toBe(awkward);
      expect(zarfeen).toEqual([
        'Zarfeen Rice Mills', 'PK', 'Lahore', '', 'matched', expect.stringMatching(/^\d\.\d{2}$/), String(firms.zarfeen), 'Zarfeen Rice Mills', 'PK', '4', 'yes', '2',
      ]);
      expect(plain.slice(9)).toEqual(['0', 'no', '0']);
      expect(merged.slice(4, 5)).toEqual(['matched']);
      expect(merged.slice(6, 9)).toEqual([String(survivor), 'Survivor Foods Co', 'PK']);
      expect(review.slice(4)).toEqual(['review', expect.stringMatching(/^\d\.\d{2}$/), '', '', '', '', '', '']);
    });

    it('an unfinished job answers 409 ROW_PENDING', async () => {
      const { jobId } = await seedUnfinished();
      const res = await owner.session.get(`/v1/bulk-jobs/${jobId}/export.csv`).expect(409);
      expect(code(res)).toBe('ROW_PENDING');
    });

    it('answers 404 for a job of another account', async () => {
      const jobId = await run([{ name: 'Qzxv Nomatch Holdings' }]);
      const other = await signUpVerified(t, { email: `other${++n}@bulk-review.test` });
      await other.session.get(`/v1/bulk-jobs/${jobId}/export.csv`).expect(404);
    });
  });

  it('review, watch-confirmed and export need a verified email', async () => {
    const jobId = await run([{ name: 'Qzxv Nomatch Holdings' }]);
    const unverified = t.session();
    await unverified
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: 'unverified@bulk-review.test', password: 'zarfeen-rice-2026', companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await unverified.post('/v1/auth/login').send({ email: 'unverified@bulk-review.test', password: 'zarfeen-rice-2026' }).expect(200);
    const res = await unverified.post(`/v1/bulk-jobs/${jobId}/watch-confirmed`).expect(403);
    expect(code(res)).toBe('EMAIL_NOT_VERIFIED');
    await unverified.get(`/v1/bulk-jobs/${jobId}/export.csv`).expect(403);
    await unverified.patch(`/v1/bulk-jobs/${jobId}/rows/1`).send({ action: 'reject' }).expect(403);
  });

  it('a signed-out caller gets 401', async () => {
    const jobId = await run([{ name: 'Qzxv Nomatch Holdings' }]);
    await t.session().get(`/v1/bulk-jobs/${jobId}/rows`).expect(401);
    await t.session().get(`/v1/bulk-jobs/${jobId}/export.csv`).expect(401);
  });
});
