import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { BULK_LIMITS, type BulkCandidate, type BulkRowStatus, type FirmSearchQuery } from '@rejectradar/contracts';
import { bulkJob, bulkJobRow, type Database } from '@rejectradar/db';
import { MATCH_CONFIG } from '@rejectradar/matching';
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { DB } from '../database/database.module';
import { type FirmSearchHit, FirmSearchService } from '../firms/firm-search.service';

/** What a processed row stores (P6-D6). */
export interface BulkRowClass {
  status: Extract<BulkRowStatus, 'matched' | 'review' | 'no_record'>;
  firmId: number | null;
  score: number | null;
  candidates: BulkCandidate[];
}

/**
 * Classifies a row from its search hits, best first (P6-D6, spec §8.4). The candidates are the top
 * `MATCH_CONFIG.bulk.keepCandidates` hits scoring at least `MATCH_CONFIG.query.other` (0.50). A top score of
 * `bulk.matched` (0.90) or more is `matched`, with the top firm; from `bulk.review` (0.75) it is `review`, and below that
 * `no_record`. Neither keeps a firm, and both store the top score, or null when no hit is a candidate.
 */
export function classifyRow(hits: FirmSearchHit[]): BulkRowClass {
  const candidates = hits
    .filter((hit) => hit.score >= MATCH_CONFIG.query.other)
    .slice(0, MATCH_CONFIG.bulk.keepCandidates)
    .map((hit): BulkCandidate => ({ firmId: hit.id, displayName: hit.displayName, countryCode: hit.countryCode, city: hit.city, score: hit.score, label: hit.label }));
  const top = candidates.at(0);
  if (top === undefined) return { status: 'no_record', firmId: null, score: null, candidates: [] };
  if (top.score >= MATCH_CONFIG.bulk.matched) return { status: 'matched', firmId: top.firmId, score: top.score, candidates };
  return { status: top.score >= MATCH_CONFIG.bulk.review ? 'review' : 'no_record', firmId: null, score: top.score, candidates };
}

/**
 * A job a worker may claim (P6-D5): `queued`, or `running` with no heartbeat or one older than `staleAfterSec`. The age is
 * measured on the database's clock, so the API's clock never matters.
 */
export function claimableJob(): SQL<boolean> {
  return sql<boolean>`(${bulkJob.status} = 'queued' or (${bulkJob.status} = 'running' and (${bulkJob.heartbeatAt} is null or ${bulkJob.heartbeatAt} < now() - ${BULK_LIMITS.staleAfterSec}::int * interval '1 second')))`;
}

/**
 * Postgres's connection-exception class (08), its insufficient-resources class (53: out of memory, disk or connections), a
 * cancelled or timed-out statement (57014) and the shutdown codes (57P01-57P03), and node's socket errors.
 */
const WORKER_CODE = /^(08[0-9A-Z]{3}|53[0-9A-Z]{3}|57014|57P0[1-3]|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)$/;
/** What node-postgres and its pool throw, without a code, when a connection is lost, broken or cannot be had. */
const WORKER_MESSAGE =
  /^(Connection terminated|Cannot use a pool after calling end on the pool|timeout exceeded when trying to connect|Client has encountered a connection error and is not queryable)/;

/**
 * Whether an error, or one in its cause chain (Drizzle wraps the driver's error), is about the database (its connection,
 * its resources or a statement it cancelled) rather than the row being matched. Such an error ends the worker instead of
 * counting against the row: the row is not at fault, and counting it would write a paid row off after a few bad seconds.
 */
export function endsWorker(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === 'string' && WORKER_CODE.test(code)) return true;
    if (typeof message === 'string' && WORKER_MESSAGE.test(message)) return true;
    current = cause;
  }
  return false;
}

type PendingRow = Pick<typeof bulkJobRow.$inferSelect, 'id' | 'inputName' | 'inputCountry' | 'inputCity' | 'inputFei'>;

/** A process-wide limit on rows matched at once, so several jobs together still leave the pool's other connections free. */
class Slots {
  private readonly waiting: (() => void)[] = [];

  constructor(private free: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      // A waiting task takes the slot over; otherwise it is free again.
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/**
 * Runs bulk jobs in this process (P6-D5, spec §9.8): a worker claims its job with one conditional update, then reads the
 * job's pending rows `batchSize` at a time, matches them `concurrency` at a time and, after each batch, recomputes
 * `processed` and beats the heartbeat.
 *
 * Every row is processed exactly once: a row is written only while it is `pending`, and `processed` is counted from the
 * rows, never incremented. So even two workers overlapping after a takeover each write a row at most once, and a job
 * resumed after a crash or a restart only reads the rows still pending. The claim keeps a second process out while the
 * heartbeat is fresh; a set of the jobs running here keeps a second start in this process out.
 *
 * A row whose match fails is retried in the next batch, and after `maxRowAttempts` failures is written `no_record`, so
 * every job finishes. Failures that are not about one row (the claim, reading a batch, the heartbeat, the database) end
 * the worker instead; the heartbeat then goes stale and the job resumes. A batch in which every row failed ends the worker
 * too, after counting them: something is wrong beyond one row, and the next attempts come on later resumes rather than
 * straight after.
 *
 * Jobs resume on the startup scan, on a read of the job or the job list, and on a sweep every `sweepEverySec`. The sweep
 * is what resumes a job after a deploy: Render starts the new instance before it stops the old one, so the new boot scan
 * still sees the old worker's fresh heartbeat.
 */
@Injectable()
export class BulkProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BulkProcessor.name);
  /** The worker of each job running in this process. Workers never reject. */
  private readonly workers = new Map<string, Promise<void>>();
  /** Scans (at startup, or by the sweep) still looking for jobs to resume. */
  private readonly scans = new Set<Promise<void>>();
  private readonly slots = new Slots(BULK_LIMITS.concurrency);
  /** The periodic scan, from bootstrap until the module is destroyed. */
  private sweep: ReturnType<typeof setInterval> | undefined;
  private stopping = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly firmSearch: FirmSearchService,
  ) {}

  /** Starts a worker for the job without waiting for it. Never throws; a job already running here, or a shutdown, makes it a no-op. */
  start(jobId: string): void {
    this.launch(jobId);
  }

  /** Starts every queued job and every running job whose heartbeat is stale; resolves with how many workers it started. */
  async resumeStale(): Promise<number> {
    const jobs = await this.db
      .select({ id: bulkJob.id })
      .from(bulkJob)
      // The status list matches `bulk_job_active_idx`, so the scan reads only the active jobs.
      .where(and(inArray(bulkJob.status, ['queued', 'running']), claimableJob()))
      .orderBy(asc(bulkJob.createdAt));
    let started = 0;
    for (const job of jobs) if (this.launch(job.id)) started++;
    return started;
  }

  /** Resolves once no worker and no scan is running in this process. */
  async idle(): Promise<void> {
    while (this.workers.size > 0 || this.scans.size > 0) {
      await Promise.allSettled([...this.workers.values(), ...this.scans]);
    }
  }

  /**
   * Resumes interrupted jobs at startup, then every `sweepEverySec`. Neither scan is awaited, so the API boots even while
   * the database is unreachable; `idle()` waits for them. The interval is `unref`'d, so it never keeps a process alive.
   */
  onApplicationBootstrap(): void {
    this.scan();
    this.sweep = setInterval(() => this.scan(), BULK_LIMITS.sweepEverySec * 1000);
    this.sweep.unref();
  }

  /**
   * Stops the sweep, then the workers between batches, and waits for the batch in flight. This is `onModuleDestroy`, not
   * `onApplicationShutdown`: Nest runs every module's destroy hook before any shutdown hook, and `DatabaseModule` (global, so
   * destroyed last) ends the pool in its own destroy hook. A shutdown hook would wait for writes against a closed pool.
   */
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweep);
    this.sweep = undefined;
    this.stopping = true;
    await this.idle();
  }

  /** One scan for jobs to resume, unless the process is stopping or a scan is still running. Never rejects. */
  private scan(): void {
    if (this.stopping || this.scans.size > 0) return;
    const scan = this.resumeStale().then(
      (count) => {
        if (count > 0) this.logger.log({ count }, 'bulk_jobs_resumed');
      },
      (err: unknown) => this.logger.error({ err }, 'bulk_resume_failed'),
    );
    this.scans.add(scan);
    void scan.finally(() => this.scans.delete(scan));
  }

  private launch(jobId: string): boolean {
    if (this.stopping || this.workers.has(jobId)) return false;
    const worker = this.work(jobId).finally(() => this.workers.delete(jobId));
    this.workers.set(jobId, worker);
    return true;
  }

  private async work(jobId: string): Promise<void> {
    try {
      if (!(await this.claim(jobId))) return;
      for (;;) {
        if (this.stopping) {
          await this.release(jobId);
          return;
        }
        const rows = await this.nextBatch(jobId);
        if (rows.length === 0) {
          await this.finish(jobId);
          return;
        }
        const failed = await this.matchBatch(jobId, rows);
        await this.beat(jobId);
        if (failed === rows.length) {
          // Every row failed: the rows written off by it may have been the last ones; otherwise pause until a resume.
          if (await this.finish(jobId)) return;
          this.logger.warn({ jobId, rows: rows.length }, 'bulk_batch_all_failed');
          return;
        }
      }
    } catch (err) {
      // The heartbeat goes stale, so the next read of the job or the next restart resumes it. Ids only: never a row's input.
      this.logger.error({ jobId, err }, 'bulk_job_batch_failed');
    }
  }

  /** Only one worker wins: the update is conditional, and a loser gets no row back. */
  private async claim(jobId: string): Promise<boolean> {
    const claimed = await this.db
      .update(bulkJob)
      .set({ status: 'running', heartbeatAt: sql`now()` })
      .where(and(eq(bulkJob.id, jobId), claimableJob()))
      .returning({ id: bulkJob.id });
    return claimed.length > 0;
  }

  private nextBatch(jobId: string): Promise<PendingRow[]> {
    return this.db
      .select({ id: bulkJobRow.id, inputName: bulkJobRow.inputName, inputCountry: bulkJobRow.inputCountry, inputCity: bulkJobRow.inputCity, inputFei: bulkJobRow.inputFei })
      .from(bulkJobRow)
      .where(and(eq(bulkJobRow.jobId, jobId), eq(bulkJobRow.status, 'pending')))
      .orderBy(asc(bulkJobRow.rowNr))
      .limit(BULK_LIMITS.batchSize);
  }

  /**
   * Matches the batch `concurrency` rows at a time. A row's own failure is counted against it and the batch goes on
   * (`processRow`). After a failure that ends the worker no further row is started, and the rows already in flight are
   * waited for, so nothing writes after the worker has ended; the first such error is then thrown. Resolves with the
   * number of rows whose failure was counted.
   */
  private async matchBatch(jobId: string, rows: PendingRow[]): Promise<number> {
    let next = 0;
    let counted = 0;
    const failures: unknown[] = [];
    const lane = async () => {
      while (failures.length === 0 && next < rows.length) {
        const row = rows[next++];
        try {
          if (!(await this.slots.run(() => this.processRow(jobId, row)))) counted++;
        } catch (error) {
          failures.push(error);
        }
      }
    };
    await Promise.all(Array.from({ length: BULK_LIMITS.concurrency }, lane));
    if (failures.length > 0) throw failures[0];
    return counted;
  }

  /**
   * Matches and writes one row; false when it failed and the failure was counted against it. An error about the database
   * (`endsWorker`), like a failure of the counting update itself, is thrown instead: it ends the worker, and the job
   * resumes later.
   */
  private async processRow(jobId: string, row: PendingRow): Promise<boolean> {
    try {
      await this.matchRow(row);
      return true;
    } catch (error) {
      if (endsWorker(error)) throw error;
      await this.countFailure(jobId, row);
      return false;
    }
  }

  /**
   * Counts a failed attempt against the row. The `maxRowAttempts`-th one also writes it `no_record`, without a firm, score
   * or candidates, so a row that can never be matched does not hold its job back for good. Like every row write, it
   * applies only while the row is `pending`. Ids only in the log: never the row's input.
   */
  private async countFailure(jobId: string, row: PendingRow): Promise<void> {
    const lastAttempt = sql`${bulkJobRow.attempts} + 1 >= ${BULK_LIMITS.maxRowAttempts}::int`;
    await this.db
      .update(bulkJobRow)
      .set({
        attempts: sql`${bulkJobRow.attempts} + 1`,
        status: sql`case when ${lastAttempt} then 'no_record' else ${bulkJobRow.status} end`,
        firmId: sql`case when ${lastAttempt} then null else ${bulkJobRow.firmId} end`,
        score: sql`case when ${lastAttempt} then null else ${bulkJobRow.score} end`,
        candidates: sql`case when ${lastAttempt} then '[]'::jsonb else ${bulkJobRow.candidates} end`,
      })
      .where(and(eq(bulkJobRow.id, row.id), eq(bulkJobRow.status, 'pending')));
    this.logger.warn({ jobId, rowId: row.id }, 'bulk_row_failed');
  }

  private async matchRow(row: PendingRow): Promise<void> {
    const query: FirmSearchQuery = {
      name: row.inputName,
      country: row.inputCountry ?? undefined,
      city: row.inputCity ?? undefined,
      fei: row.inputFei ?? undefined,
    };
    const result = classifyRow(await this.firmSearch.searchWithEvidence(query));
    await this.db
      .update(bulkJobRow)
      .set({ status: result.status, firmId: result.firmId, score: result.score === null ? null : result.score.toFixed(4), candidates: result.candidates })
      .where(and(eq(bulkJobRow.id, row.id), eq(bulkJobRow.status, 'pending')));
  }

  /** `processed` is counted from the rows, so a batch written twice by overlapping workers is never counted twice. */
  private processedCount(jobId: string): SQL<number> {
    return sql<number>`(select count(*)::int from ${bulkJobRow} where ${bulkJobRow.jobId} = ${jobId} and ${bulkJobRow.status} <> 'pending')`;
  }

  private async beat(jobId: string): Promise<void> {
    await this.db
      .update(bulkJob)
      .set({ processed: this.processedCount(jobId), heartbeatAt: sql`now()` })
      .where(and(eq(bulkJob.id, jobId), eq(bulkJob.status, 'running')));
  }

  /** Finishes the job if no row is pending; true when it did. */
  private async finish(jobId: string): Promise<boolean> {
    const finished = await this.db
      .update(bulkJob)
      .set({ status: 'finished', processed: this.processedCount(jobId), heartbeatAt: sql`now()`, finishedAt: sql`now()` })
      .where(
        and(
          eq(bulkJob.id, jobId),
          eq(bulkJob.status, 'running'),
          sql`not exists (select 1 from ${bulkJobRow} where ${bulkJobRow.jobId} = ${jobId} and ${bulkJobRow.status} = 'pending')`,
        ),
      )
      .returning({ id: bulkJob.id });
    return finished.length > 0;
  }

  /**
   * A worker stopped by a shutdown gives its claim up: with no heartbeat the job is claimable at once, so the next boot
   * (a deploy starts the new instance seconds later) resumes it instead of waiting for the heartbeat to age.
   */
  private async release(jobId: string): Promise<void> {
    await this.db
      .update(bulkJob)
      .set({ heartbeatAt: null })
      .where(and(eq(bulkJob.id, jobId), eq(bulkJob.status, 'running')));
  }
}
