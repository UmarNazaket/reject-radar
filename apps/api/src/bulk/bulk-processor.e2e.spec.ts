import type { BulkCandidate, BulkJobResponse, FirmSearchQuery } from '@rejectradar/contracts';
import { bulkJob, bulkJobRow, firmFei, testDatabaseUrl, usageCounter, uuidv7 } from '@rejectradar/db';
import { insertFirm } from '@rejectradar/entities';
import { asc, eq, sql } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { FirmSearchService } from '../firms/firm-search.service';
import { openTestApp, setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';
import { BulkProcessor } from './bulk-processor';

const SUFFIX = 'api_bulk_processor';
const LOG_ENV = { LOG_LEVEL: 'info' };

/** The real search, kept before it is spied on, so a spec can wrap it (slow it down, or fail one call). */
const realSearch = FirmSearchService.prototype.searchWithEvidence;
const callThrough = function (this: FirmSearchService, query: FirmSearchQuery) {
  return realSearch.call(this, query);
};

interface Input {
  name: string;
  country: string;
  city?: string;
  fei?: string;
}

interface LogLine {
  level: number;
  msg?: string;
  jobId?: string;
  rowId?: number;
  err?: { message?: string };
}

describe('bulk processor (P6-D5, P6-D6)', () => {
  // nestjs-pino keeps one root logger per process: every app this spec boots writes here.
  const chunks: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const search = jest.spyOn(FirmSearchService.prototype, 'searchWithEvidence');

  let t: TestApp;
  let processor: BulkProcessor;
  let owner: { session: TestSession; orgId: string; userId: string };
  const firms = { zarfeen: 0, alRahmanLahore: 0, alRahmanKarachi: 0, alNoorPk: 0, alNoorIn: 0, byFei: 0 };
  const FEI = '3001112223';

  beforeAll(async () => {
    t = await startTestApp(SUFFIX, { logStream }, LOG_ENV);
    t.app.flushLogs();
    processor = t.app.get(BulkProcessor);
    firms.zarfeen = await insertFirm(t.db, { displayName: 'Zarfeen Rice Mills', countryCode: 'PK', city: 'lahore' });
    firms.alRahmanLahore = await insertFirm(t.db, { displayName: 'Al Rahman Rice Mills', countryCode: 'PK', city: 'lahore' });
    firms.alRahmanKarachi = await insertFirm(t.db, { displayName: 'Al Rahman Rice Mills', countryCode: 'PK', city: 'karachi' });
    firms.alNoorPk = await insertFirm(t.db, { displayName: 'Al Noor Foods', countryCode: 'PK', city: 'karachi' });
    firms.alNoorIn = await insertFirm(t.db, { displayName: 'Al Noor Foods', countryCode: 'IN', city: 'delhi' });
    firms.byFei = await insertFirm(t.db, { displayName: 'Feiwala Spice Exporters', countryCode: 'PK', city: 'multan' });
    await t.db.insert(firmFei).values({ fei: Number(FEI), firmId: firms.byFei });
    owner = await signUpVerified(t, { email: 'owner@bulk-processor.test' });
    await setPlan(t, owner.orgId, 'business');
  });

  afterAll(async () => {
    await t.close();
    search.mockRestore();
  });

  beforeEach(() => {
    t.resetRateLimits();
    search.mockClear();
  });

  afterEach(async () => {
    search.mockImplementation(callThrough);
    await processor.idle();
  });

  const csv = (rows: Input[]) =>
    ['name,country,city,fei', ...rows.map((r) => `${r.name},${r.country},${r.city ?? ''},${r.fei ?? ''}`)].join('\r\n') + '\r\n';

  const upload = async (rows: Input[]): Promise<string> => {
    const res = await owner.session.post('/v1/bulk-jobs').query({ fileName: 'suppliers.csv' }).set('Content-Type', 'text/csv').send(csv(rows)).expect(202);
    return (res.body as BulkJobResponse).id;
  };

  const STRONG: Input = { name: 'Zarfeen Rice Mills', country: 'PK', city: 'Lahore' };
  const REVIEW: Input = { name: 'Al Rahman Rice Mills', country: 'PK' };
  const NO_RECORD: Input = { name: 'Qwxyz Unheard Of Exporters', country: 'PK' };

  /** A value no search would produce, so a row written again would show. */
  const SENTINEL: BulkCandidate = { firmId: 0, displayName: 'Sentinel, written before the restart', countryCode: 'PK', city: 'lahore', score: 0.9123, label: 'strong' };

  /**
   * A job written straight to the tables, as a crashed API would leave it: `done` rows already matched (with sentinel
   * values), the rest `pending`. `heartbeatAgo` is in seconds, against the database's clock; null leaves it unset.
   */
  async function seedJob(opts: { status: 'queued' | 'running'; heartbeatAgo: number | null; rows: Input[]; done?: number }): Promise<string> {
    const id = uuidv7();
    const done = opts.done ?? 0;
    await t.db.insert(bulkJob).values({
      id,
      orgId: owner.orgId,
      createdBy: owner.userId,
      fileName: 'seeded.csv',
      status: opts.status,
      total: opts.rows.length,
      processed: done,
      heartbeatAt: opts.heartbeatAgo === null ? null : sql`now() - ${opts.heartbeatAgo}::int * interval '1 second'`,
    });
    await t.db.insert(bulkJobRow).values(
      opts.rows.map((row, i) => ({
        jobId: id,
        rowNr: i + 1,
        inputName: row.name,
        inputCountry: row.country,
        inputCity: row.city ?? null,
        inputFei: row.fei ?? null,
        ...(i < done ? { status: 'matched', firmId: firms.zarfeen, score: '0.9123', candidates: [{ ...SENTINEL, firmId: firms.zarfeen }] } : {}),
      })),
    );
    return id;
  }

  const jobOf = async (id: string) => (await t.db.select().from(bulkJob).where(eq(bulkJob.id, id)))[0];
  const rowsOf = (id: string) => t.db.select().from(bulkJobRow).where(eq(bulkJobRow.jobId, id)).orderBy(asc(bulkJobRow.rowNr));
  const pendingOf = async (id: string) => (await rowsOf(id)).filter((row) => row.status === 'pending').length;
  const bulkRowsUsed = async () => (await t.db.select({ used: usageCounter.bulkRows }).from(usageCounter).where(eq(usageCounter.orgId, owner.orgId)))[0]?.used ?? 0;
  const logLines = (): LogLine[] =>
    chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine);
  /** pino's `error` is 50 and `fatal` 60. */
  const errorLines = () => logLines().filter((line) => line.level >= 50);
  /**
   * Boots the API again on this spec's database, rows kept, as a restart would. Each boot buffers Nest's logs until the app listens,
   * which a spec app never does; flushing sends them, and every later line, to the log stream.
   */
  const boot = async () => {
    const app = await openTestApp(testDatabaseUrl(SUFFIX), { logStream }, LOG_ENV);
    app.app.flushLogs();
    return app;
  };

  async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('a job runs to the end: 120 rows in 3 batches, each row classified', async () => {
    const used = await bulkRowsUsed();
    const inputs = Array.from({ length: 120 }, (_, i) => [STRONG, REVIEW, NO_RECORD][i % 3]);
    const id = await upload(inputs);
    await processor.idle();

    const job = await jobOf(id);
    expect(job).toMatchObject({ status: 'finished', total: 120, processed: 120 });
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(job.heartbeatAt).toBeInstanceOf(Date);
    expect(search).toHaveBeenCalledTimes(120);
    // Charged once, at the upload (P6-D4); processing charges nothing.
    expect(await bulkRowsUsed()).toBe(used + 120);

    const rows = await rowsOf(id);
    expect(rows.map((row) => row.status)).toEqual(inputs.map((input) => (input === STRONG ? 'matched' : input === REVIEW ? 'review' : 'no_record')));
    expect(rows[0]).toMatchObject({
      status: 'matched',
      firmId: firms.zarfeen,
      score: '0.9600',
      candidates: [{ firmId: firms.zarfeen, displayName: 'Zarfeen Rice Mills', countryCode: 'PK', city: 'lahore', score: 0.96, label: 'strong' }],
    });
    expect(rows[1]).toMatchObject({ status: 'review', firmId: null, score: '0.8500' });
    expect((rows[1].candidates as BulkCandidate[]).map((c) => [c.firmId, c.score])).toEqual([
      [firms.alRahmanLahore, 0.85],
      [firms.alRahmanKarachi, 0.85],
    ]);
    expect(rows[2]).toMatchObject({ status: 'no_record', firmId: null, score: null, candidates: [] });

    const read = await owner.session.get(`/v1/bulk-jobs/${id}`).expect(200);
    expect(read.body).toMatchObject({ status: 'finished', processed: 120, total: 120, finishedAt: expect.any(String) });
  });

  it('country is a filter: the same name in PK and IN matches only the row\'s country', async () => {
    const id = await upload([
      { name: 'Al Noor Foods', country: 'PK' },
      { name: 'Al Noor Foods', country: 'IN' },
    ]);
    await processor.idle();
    const [pk, india] = await rowsOf(id);
    // Each is the only near-exact name within its country, so each is unique (P6-D6): 0.85 + 0.05.
    expect(pk).toMatchObject({ status: 'matched', firmId: firms.alNoorPk, score: '0.9000' });
    expect((pk.candidates as BulkCandidate[]).map((c) => c.firmId)).toEqual([firms.alNoorPk]);
    expect(india).toMatchObject({ status: 'matched', firmId: firms.alNoorIn, score: '0.9000' });
    expect((india.candidates as BulkCandidate[]).map((c) => c.firmId)).toEqual([firms.alNoorIn]);
  });

  it('an FEI wins: a known FEI under another name is matched with score 1', async () => {
    const id = await upload([{ name: 'Something Else Entirely Ltd', country: 'PK', fei: FEI }]);
    await processor.idle();
    const [row] = await rowsOf(id);
    expect(row).toMatchObject({
      status: 'matched',
      firmId: firms.byFei,
      score: '1.0000',
      candidates: [{ firmId: firms.byFei, displayName: 'Feiwala Spice Exporters', score: 1, label: 'strong' }],
    });
  });

  it('a restart in the middle finishes the job, every row processed exactly once (Review Focus 1)', async () => {
    const used = await bulkRowsUsed();
    const main = await seedJob({ status: 'running', heartbeatAgo: 61, rows: Array.from({ length: 120 }, () => STRONG), done: 60 });
    const queued = await seedJob({ status: 'queued', heartbeatAgo: null, rows: [STRONG, REVIEW, NO_RECORD] });
    const neverBeat = await seedJob({ status: 'running', heartbeatAgo: null, rows: [STRONG, NO_RECORD] });
    const fresh = await seedJob({ status: 'running', heartbeatAgo: 10, rows: [STRONG, REVIEW] });
    const before = (await rowsOf(main)).slice(0, 60);

    const restarted = await boot();
    try {
      await restarted.app.get(BulkProcessor).idle();
    } finally {
      await restarted.close();
    }

    expect(await jobOf(main)).toMatchObject({ status: 'finished', total: 120, processed: 120 });
    const after = await rowsOf(main);
    // The 60 rows written before the restart were not written again: their sentinel values are still there.
    expect(after.slice(0, 60)).toEqual(before);
    expect(after.slice(60).every((row) => row.status === 'matched' && row.score === '0.9600')).toBe(true);
    // A queued job, and a running one that never beat, resume too; one whose heartbeat is fresh is left to its worker.
    expect(await jobOf(queued)).toMatchObject({ status: 'finished', processed: 3 });
    expect(await jobOf(neverBeat)).toMatchObject({ status: 'finished', processed: 2 });
    expect(await jobOf(fresh)).toMatchObject({ status: 'running', processed: 0 });
    expect(await pendingOf(fresh)).toBe(2);
    expect(search).toHaveBeenCalledTimes(60 + 3 + 2);
    expect(await bulkRowsUsed()).toBe(used);

    await t.db.delete(bulkJob).where(eq(bulkJob.id, fresh));
  });

  it('a fresh heartbeat is left alone by GET; at 61 s the GET resumes the job', async () => {
    const id = await seedJob({ status: 'running', heartbeatAgo: 10, rows: [STRONG, REVIEW, NO_RECORD] });

    const fresh = await owner.session.get(`/v1/bulk-jobs/${id}`).expect(200);
    expect(fresh.body).toMatchObject({ id, status: 'running', processed: 0 });
    await processor.idle();
    expect(await pendingOf(id)).toBe(3);
    expect(search).not.toHaveBeenCalled();
    expect(await processor.resumeStale()).toBe(0);

    await t.db.update(bulkJob).set({ heartbeatAt: sql`now() - interval '61 seconds'` }).where(eq(bulkJob.id, id));
    // The answer is the job as it is; the resumed worker runs after it.
    const stale = await owner.session.get(`/v1/bulk-jobs/${id}`).expect(200);
    expect(stale.body).toMatchObject({ id, status: 'running' });
    await processor.idle();
    expect(await jobOf(id)).toMatchObject({ status: 'finished', processed: 3 });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('resumeStale counts the jobs it started', async () => {
    const a = await seedJob({ status: 'queued', heartbeatAgo: null, rows: [STRONG] });
    const b = await seedJob({ status: 'running', heartbeatAgo: 61, rows: [NO_RECORD] });
    expect(await processor.resumeStale()).toBe(2);
    await processor.idle();
    expect(await jobOf(a)).toMatchObject({ status: 'finished', processed: 1 });
    expect(await jobOf(b)).toMatchObject({ status: 'finished', processed: 1 });
    expect(await processor.resumeStale()).toBe(0);
  });

  it('two workers race: the claim lets one run, and each row is searched once', async () => {
    const id = await seedJob({ status: 'queued', heartbeatAgo: null, rows: Array.from({ length: 120 }, (_, i) => [STRONG, NO_RECORD][i % 2]) });
    // A second processor stands in for a second API process: only the database claim keeps it out.
    const other = new BulkProcessor(t.db, t.app.get(FirmSearchService));
    processor.start(id);
    other.start(id);
    await Promise.all([processor.idle(), other.idle()]);
    expect(search).toHaveBeenCalledTimes(120);
    expect(await jobOf(id)).toMatchObject({ status: 'finished', processed: 120 });
    expect(await pendingOf(id)).toBe(0);
  });

  it('a second start in the same process while its worker runs does nothing', async () => {
    const id = await seedJob({ status: 'queued', heartbeatAgo: null, rows: Array.from({ length: 60 }, () => STRONG) });
    processor.start(id);
    processor.start(id);
    await processor.idle();
    expect(search).toHaveBeenCalledTimes(60);
    expect(await jobOf(id)).toMatchObject({ status: 'finished', processed: 60 });
  });

  it('a connection error ends the worker without counting against the row, and the job resumes once stale', async () => {
    const secretName = 'Confidential Supplier Name Pvt Ltd';
    const id = await seedJob({ status: 'queued', heartbeatAgo: null, rows: Array.from({ length: 60 }, () => ({ name: secretName, country: 'PK' })) });
    let calls = 0;
    search.mockImplementation(async function (this: FirmSearchService, query: FirmSearchQuery) {
      if (++calls === 3) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      return realSearch.call(this, query);
    });
    chunks.length = 0;
    processor.start(id);
    await processor.idle();

    const failed = logLines().filter((line) => line.msg === 'bulk_job_batch_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: 50, jobId: id, err: { message: 'read ECONNRESET' } });
    expect(logLines().filter((line) => line.msg === 'bulk_row_failed')).toEqual([]);
    expect(chunks.join('')).not.toContain(secretName);
    const job = await jobOf(id);
    expect(job.status).toBe('running');
    expect(await pendingOf(id)).toBeGreaterThan(0);
    expect((await rowsOf(id)).every((row) => row.attempts === 0)).toBe(true);

    // The worker is gone and its heartbeat ages; the next GET resumes the job.
    search.mockImplementation(callThrough);
    await t.db.update(bulkJob).set({ heartbeatAt: sql`now() - interval '61 seconds'` }).where(eq(bulkJob.id, id));
    await owner.session.get(`/v1/bulk-jobs/${id}`).expect(200);
    await processor.idle();
    expect(await jobOf(id)).toMatchObject({ status: 'finished', processed: 60 });
    expect(await pendingOf(id)).toBe(0);
  });

  it('a row whose match always fails is no_record after 3 attempts, and the job finishes', async () => {
    const poison = 'Poison Pill Exporters Ltd';
    // Two failing rows, one in each of the job's two batches; the others are ordinary strong matches.
    const inputs = Array.from({ length: 60 }, (_, i) => (i === 4 || i === 57 ? { name: poison, country: 'PK' } : STRONG));
    const id = await seedJob({ status: 'queued', heartbeatAgo: null, rows: inputs });
    search.mockImplementation(async function (this: FirmSearchService, query: FirmSearchQuery) {
      if (query.name === poison) throw new Error('this row cannot be matched');
      return realSearch.call(this, query);
    });
    chunks.length = 0;
    processor.start(id);
    await processor.idle();

    expect(await jobOf(id)).toMatchObject({ status: 'finished', total: 60, processed: 60 });
    const rows = await rowsOf(id);
    const failedRows = [rows[4], rows[57]];
    for (const row of failedRows) expect(row).toMatchObject({ status: 'no_record', firmId: null, score: null, candidates: [], attempts: 3 });
    const others = rows.filter((row) => !failedRows.includes(row));
    expect(others.every((row) => row.status === 'matched' && row.score === '0.9600' && row.attempts === 0)).toBe(true);
    expect(search.mock.calls.filter(([query]) => query.name === poison)).toHaveLength(6);

    const lines = logLines().filter((line) => line.msg === 'bulk_row_failed');
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(line).toMatchObject({ jobId: id, rowId: expect.any(Number) });
    expect(new Set(lines.map((line) => line.rowId))).toEqual(new Set(failedRows.map((row) => row.id)));
    expect(logLines().filter((line) => line.msg === 'bulk_job_batch_failed')).toEqual([]);
    expect(chunks.join('')).not.toContain(poison);
  });

  it('a row that fails once and then succeeds is classified normally, with 1 attempt', async () => {
    const flaky = 'Al Rahman Rice Mills';
    const id = await seedJob({ status: 'queued', heartbeatAgo: null, rows: [STRONG, { name: flaky, country: 'PK' }, NO_RECORD] });
    let failedOnce = false;
    search.mockImplementation(async function (this: FirmSearchService, query: FirmSearchQuery) {
      if (query.name === flaky && !failedOnce) {
        failedOnce = true;
        throw new Error('a passing hiccup');
      }
      return realSearch.call(this, query);
    });
    processor.start(id);
    await processor.idle();

    expect(await jobOf(id)).toMatchObject({ status: 'finished', processed: 3 });
    const [strong, retried, none] = await rowsOf(id);
    expect(strong).toMatchObject({ status: 'matched', attempts: 0 });
    expect(retried).toMatchObject({ status: 'review', score: '0.8500', attempts: 1 });
    expect((retried.candidates as BulkCandidate[]).map((c) => c.firmId)).toEqual([firms.alRahmanLahore, firms.alRahmanKarachi]);
    expect(none).toMatchObject({ status: 'no_record', attempts: 0 });
  });

  it('shutdown: close() mid-job stops between batches without an error, and the next boot finishes the job', async () => {
    const id = await seedJob({ status: 'queued', heartbeatAgo: null, rows: Array.from({ length: 200 }, () => STRONG) });
    // Slow each search a little, so the close lands while the job still has batches to go.
    search.mockImplementation(async function (this: FirmSearchService, query: FirmSearchQuery) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return realSearch.call(this, query);
    });
    chunks.length = 0;

    const first = await boot();
    await waitFor(async () => (await jobOf(id)).processed >= 50);
    await first.close();

    expect(errorLines()).toEqual([]);
    const stopped = await jobOf(id);
    expect(stopped.status).toBe('running');
    expect(stopped.processed).toBeLessThan(200);
    // Stopped between batches: `processed` is exactly the rows written, and no row was searched without being written.
    expect(await pendingOf(id)).toBe(200 - stopped.processed);
    expect(search).toHaveBeenCalledTimes(stopped.processed);

    // The stopped worker gave its claim up (no heartbeat), so a boot straight after, as on a deploy, resumes the job.
    expect(stopped.heartbeatAt).toBeNull();
    const second = await boot();
    try {
      await second.app.get(BulkProcessor).idle();
    } finally {
      await second.close();
    }
    expect(await jobOf(id)).toMatchObject({ status: 'finished', processed: 200 });
    expect(search).toHaveBeenCalledTimes(200);
    expect(errorLines()).toEqual([]);
  });
});
