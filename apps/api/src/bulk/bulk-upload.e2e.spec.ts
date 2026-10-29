import { type BulkJobListResponse, type BulkJobResponse, utcPeriod } from '@rejectradar/contracts';
import { bulkJob, bulkJobRow, usageCounter } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('bulk upload and job reads', () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_bulk_upload');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  /** A fresh verified account, on Business (bulk screening, 5,000 rows a month) unless `plan` says otherwise. */
  async function account(plan: 'pro' | 'business' = 'business') {
    const who = await signUpVerified(t, { email: `user${++n}@bulk-upload.test` });
    await setPlan(t, who.orgId, plan);
    return who;
  }

  /** A CSV with `count` supplier rows. */
  const csv = (count: number) =>
    ['name,country,city,fei', ...Array.from({ length: count }, (_, i) => `Supplier ${i + 1} Foods Ltd,PK,Karachi,`)].join('\r\n') + '\r\n';

  const upload = (session: TestSession, body: string, fileName: string | null = 'suppliers.csv', contentType = 'text/csv') => {
    const req = session.post('/v1/bulk-jobs').set('Content-Type', contentType);
    if (fileName !== null) req.query({ fileName });
    return req.send(body);
  };

  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const jobs = (orgId: string) => t.db.select().from(bulkJob).where(eq(bulkJob.orgId, orgId));
  const bulkRows = async (orgId: string) => (await t.db.select({ used: usageCounter.bulkRows }).from(usageCounter).where(eq(usageCounter.orgId, orgId)))[0]?.used ?? 0;
  const setUsed = (orgId: string, used: number) =>
    t.db.execute(sql`insert into usage_counter (org_id, period, bulk_rows) values (${orgId}, ${utcPeriod()}, ${used})`);

  it('a Business account uploads', async () => {
    const { session, orgId } = await account();
    const res = await upload(session, csv(3)).expect(202);
    expect(res.body).toMatchObject({ status: 'queued', total: 3, processed: 0, fileName: 'suppliers.csv', finishedAt: null });
    const { id } = res.body as BulkJobResponse;

    const rows = await t.db.select().from(bulkJobRow).where(eq(bulkJobRow.jobId, id)).orderBy(bulkJobRow.rowNr);
    expect(rows.map((row) => [row.rowNr, row.status, row.inputName, row.inputCountry, row.inputCity, row.inputFei])).toEqual([
      [1, 'pending', 'Supplier 1 Foods Ltd', 'PK', 'Karachi', null],
      [2, 'pending', 'Supplier 2 Foods Ltd', 'PK', 'Karachi', null],
      [3, 'pending', 'Supplier 3 Foods Ltd', 'PK', 'Karachi', null],
    ]);
    expect(await bulkRows(orgId)).toBe(3);
    const [job] = await jobs(orgId);
    expect(job).toMatchObject({ id, status: 'queued', total: 3, processed: 0 });
  });

  it('a Pro account is asked to upgrade, and nothing is written', async () => {
    const { session, orgId } = await account('pro');
    const res = await upload(session, csv(2)).expect(403);
    expect(res.body).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', details: { feature: 'bulk', plan: 'pro' } });
    expect(await jobs(orgId)).toHaveLength(0);
    expect(await bulkRows(orgId)).toBe(0);
  });

  describe('quota edge', () => {
    it('4,999 of 5,000 used refuses a 2-row file and writes no job', async () => {
      const { session, orgId } = await account();
      await setUsed(orgId, 4999);
      const res = await upload(session, csv(2)).expect(403);
      expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'bulk_rows', plan: 'business', limit: 5000, used: 4999 } });
      expect(await jobs(orgId)).toHaveLength(0);
      expect(await bulkRows(orgId)).toBe(4999);
      await upload(session, csv(1)).expect(202);
      expect(await bulkRows(orgId)).toBe(5000);
    });

    it('two simultaneous 3,000-row uploads on a fresh month give one 202 and one 403', async () => {
      const { session, orgId } = await account();
      const body = csv(3000);
      const results = await Promise.all([upload(session, body), upload(session, body)]);
      expect(results.map((res) => res.status).sort()).toEqual([202, 403]);
      expect(results.find((res) => res.status === 403)?.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'bulk_rows', limit: 5000 } });
      expect(await bulkRows(orgId)).toBe(3000);
      const stored = await jobs(orgId);
      expect(stored).toHaveLength(1);
      const [{ count }] = (await t.db.execute<{ count: number }>(sql`select count(*)::int as count from bulk_job_row where job_id = ${stored[0].id}`)).rows;
      expect(count).toBe(3000);
    });
  });

  describe('request shape', () => {
    it.each(['application/json', 'multipart/form-data; boundary=x', 'text/plain'])('%s answers 415', async (contentType) => {
      const { session, orgId } = await account();
      const res = await upload(session, contentType === 'application/json' ? '{"a":1}' : csv(1), 'suppliers.csv', contentType).expect(415);
      expect(code(res)).toBe('UNSUPPORTED_FILE_TYPE');
      expect(await jobs(orgId)).toHaveLength(0);
    });

    it('a file name that is missing, not .csv or over 200 characters answers 415', async () => {
      const { session, orgId } = await account();
      for (const fileName of [null, '', 'x.txt', 'suppliers', `${'a'.repeat(197)}.csv`]) {
        const res = await upload(session, csv(1), fileName).expect(415);
        expect({ fileName, code: code(res) }).toEqual({ fileName, code: 'UNSUPPORTED_FILE_TYPE' });
      }
      expect(await jobs(orgId)).toHaveLength(0);
      expect(await bulkRows(orgId)).toBe(0);
    });

    it('a repeated fileName parameter answers 415', async () => {
      const { session } = await account();
      const res = await session.post('/v1/bulk-jobs?fileName=a.csv&fileName=b.csv').set('Content-Type', 'text/csv').send(csv(1)).expect(415);
      expect(code(res)).toBe('UNSUPPORTED_FILE_TYPE');
    });

    it('accepts text/csv with a charset, and an upper-case .CSV', async () => {
      const { session } = await account();
      const res = await upload(session, csv(1), 'SUPPLIERS.CSV', 'text/csv; charset=utf-8').expect(202);
      expect(res.body).toMatchObject({ fileName: 'SUPPLIERS.CSV', total: 1 });
      await upload(session, csv(1), `${'a'.repeat(196)}.csv`).expect(202);
    });

    it('a parser error writes nothing and charges nothing', async () => {
      const { session, orgId } = await account();
      const res = await upload(session, 'name,country\r\nX,PK\r\nGood Foods Ltd,Atlantis\r\n').expect(400);
      expect(res.body).toMatchObject({ code: 'INVALID_ROWS', details: { count: 2 } });
      expect(await jobs(orgId)).toHaveLength(0);
      expect(await bulkRows(orgId)).toBe(0);
    });

    it('a file over 2 MB answers 413 and charges nothing', async () => {
      const { session, orgId } = await account();
      // 2,400 rows of about 1 KB each: over the byte limit, under the row limit. The client is still sending when the answer is due.
      const res = await upload(session, `name,country\r\n${`${'Big Foods Ltd '.repeat(70)},PK\r\n`.repeat(2400)}`).expect(413);
      expect(code(res)).toBe('FILE_TOO_LARGE');
      expect(await jobs(orgId)).toHaveLength(0);
      expect(await bulkRows(orgId)).toBe(0);
    });

    it('a file of more than 5,000 rows answers 400 TOO_MANY_ROWS and charges nothing', async () => {
      const { session, orgId } = await account();
      const res = await upload(session, csv(5001)).expect(400);
      expect(code(res)).toBe('TOO_MANY_ROWS');
      expect(await jobs(orgId)).toHaveLength(0);
      expect(await bulkRows(orgId)).toBe(0);
    });
  });

  it('needs a verified email', async () => {
    const unverified = t.session();
    await unverified
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: 'unverified@bulk-upload.test', password: 'zarfeen-rice-2026', companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await unverified.post('/v1/auth/login').send({ email: 'unverified@bulk-upload.test', password: 'zarfeen-rice-2026' }).expect(200);
    const res = await upload(unverified, csv(1)).expect(403);
    expect(code(res)).toBe('EMAIL_NOT_VERIFIED');
  });

  it('needs a session', async () => {
    await upload(t.session(), csv(1)).expect(401);
    await t.session().get('/v1/bulk-jobs').expect(401);
  });

  it('needs the CSRF header', async () => {
    const { session, orgId } = await account();
    const res = await request(t.app.getHttpServer())
      .post('/v1/bulk-jobs')
      .query({ fileName: 'suppliers.csv' })
      .set('Cookie', `rr_at=${session.cookie('rr_at')}`)
      .set('Content-Type', 'text/csv')
      .send(csv(1))
      .expect(403);
    expect(code(res)).toBe('CSRF_MISSING');
    expect(await jobs(orgId)).toHaveLength(0);
  });

  it('the 11th upload within an hour by one user is rate limited', async () => {
    const { session, orgId } = await account();
    for (let i = 0; i < 10; i++) await upload(session, csv(1)).expect(202);
    const res = await upload(session, csv(1)).expect(429);
    expect(code(res)).toBe('RATE_LIMITED');
    expect(await jobs(orgId)).toHaveLength(10);
  });

  describe('reads', () => {
    it('lists the account\'s jobs, newest first', async () => {
      const { session } = await account();
      const other = await account();
      const first = (await upload(session, csv(1), 'first.csv').expect(202)).body as BulkJobResponse;
      const second = (await upload(session, csv(2), 'second.csv').expect(202)).body as BulkJobResponse;
      await upload(other.session, csv(1), 'someone-elses.csv').expect(202);

      const res = await session.get('/v1/bulk-jobs').expect(200);
      const { jobs: listed } = res.body as BulkJobListResponse;
      expect(listed.map((job) => job.id)).toEqual([second.id, first.id]);
      expect(listed[0]).toMatchObject({ fileName: 'second.csv', status: 'queued', total: 2, processed: 0 });
      expect(JSON.stringify(res.body)).not.toContain('someone-elses');
    });

    it('lists only the newest 50', async () => {
      const { orgId, session } = await account();
      await t.db.execute(sql`
        insert into bulk_job (id, org_id, file_name, status, total, processed, finished_at)
        select gen_random_uuid(), ${orgId}, 'old-' || g || '.csv', 'finished', 1, 1, now()
        from generate_series(1, 55) g`);
      const { jobs: listed } = (await session.get('/v1/bulk-jobs').expect(200)).body as BulkJobListResponse;
      expect(listed).toHaveLength(50);
    });

    it('reads one job; another account\'s job, and ids that are not jobs, are 404', async () => {
      const mine = await account();
      const theirs = await account();
      const { id } = (await upload(mine.session, csv(2)).expect(202)).body as BulkJobResponse;
      const theirId = ((await upload(theirs.session, csv(1)).expect(202)).body as BulkJobResponse).id;

      const res = await mine.session.get(`/v1/bulk-jobs/${id}`).expect(200);
      expect(res.body).toMatchObject({ id, status: 'queued', total: 2, processed: 0 });

      const foreign = await mine.session.get(`/v1/bulk-jobs/${theirId}`).expect(404);
      expect(code(foreign)).toBe('NOT_FOUND');
      await mine.session.get('/v1/bulk-jobs/00000000-0000-7000-8000-000000000000').expect(404);
      await mine.session.get('/v1/bulk-jobs/not-a-uuid').expect(404);
    });

    it('serves the template: the header and an example row', async () => {
      const { session } = await account('pro');
      const res = await session.get('/v1/bulk-jobs/template.csv').expect(200);
      expect(res.type).toBe('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.text).toBe('name,country,city,fei\r\nExample Foods Pvt Ltd,PK,Karachi,\r\n');
    });
  });
});
