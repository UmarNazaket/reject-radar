import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  BULK_LIMITS,
  type BulkCandidate,
  type BulkDelimiter,
  type BulkJobListResponse,
  type BulkJobResponse,
  type BulkJobStatus,
  type BulkRowResponse,
  type BulkRowReviewRequest,
  type BulkRowsResponse,
  type BulkRowStatus,
  type WatchConfirmedResponse,
} from '@rejectradar/contracts';
import { type Database, bulkJob, bulkJobRow, uuidv7 } from '@rejectradar/db';
import { and, asc, desc, eq, gt, type SQL, sql } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { toCsvRow } from '../common/csv';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { type FirmSummary, FirmProfileService } from '../firms/firm-profile.service';
import { WatchlistsService } from '../watchlists/watchlists.service';
import { type BulkInputRow, parseBulkCsv } from './bulk-csv';
import { BulkProcessor, claimableJob } from './bulk-processor';

/** The template a user starts from: the header line and one example row, each ending in CRLF (P6-D10). */
export const TEMPLATE_CSV = [toCsvRow(['name', 'country', 'city', 'fei']), toCsvRow(['Example Foods Pvt Ltd', 'PK', 'Karachi', null])]
  .map((line) => `${line}\r\n`)
  .join('');

/** Rows per insert statement; six columns each stay far under Postgres' parameter limit. */
const INSERT_CHUNK = 500;
/** `GET /v1/bulk-jobs` returns the newest this many jobs. */
const LIST_LIMIT = 50;

/** The columns of the export, in order (P6-D9). */
export const EXPORT_HEADER = [
  'name', 'country', 'city', 'fei', 'status', 'score', 'firm_id', 'firm_name', 'firm_country', 'fda_refusals_3y', 'import_alert_red', 'au_failed_3y',
] as const;

/**
 * The page cursor is the P5 cursor (`<date>|<id>`) with the row number as its id; rows have no date, so a fixed one stands in
 * and `decodeCursor` still rejects anything that is not a cursor of this shape.
 */
const ROW_CURSOR_DATE = '2000-01-01';

type JobRow = typeof bulkJob.$inferSelect;
type RowRecord = typeof bulkJobRow.$inferSelect;

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
const rowPending = () => new AppError(HttpStatus.CONFLICT, 'ROW_PENDING', 'This is still being processed. Try again in a moment.');

/** The largest row number a cursor may hold: `row_nr` is a Postgres `integer`. */
const MAX_ROW_NR = 2_147_483_647;

/** UTF-8's byte order mark: without it Excel reads a CSV in the locale's code page, and every non-ASCII name is garbled. */
const BOM = String.fromCharCode(0xfeff);

/** The score as a number, or null; Postgres returns `numeric` as text. */
const scoreOf = (row: RowRecord): number | null => (row.score === null ? null : Number(row.score));

/**
 * A `no_record` row written after `maxRowAttempts` failed searches: nothing is known about it, which is not the same as no
 * record found. The database keeps it `no_record` (the status check); the API marks it `failed` and the export
 * `search_failed`.
 */
const searchFailed = (row: RowRecord): boolean => row.status === 'no_record' && row.attempts >= BULK_LIMITS.maxRowAttempts;

/** The row number after which a page starts; anything that is not a row number Postgres can hold is `400`, like a malformed cursor. */
function cursorRowNr(cursor: string): number {
  const rowNr = Number(decodeCursor(cursor).id);
  if (!Number.isSafeInteger(rowNr) || rowNr < 1 || rowNr > MAX_ROW_NR) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'The page cursor is not valid.');
  }
  return rowNr;
}

/** The distinct firms rows point at. */
const distinctFirmIds = (rows: readonly RowRecord[]): number[] => [...new Set(rows.flatMap((row) => (row.firmId === null ? [] : [row.firmId])))];

const toRowResponse = (row: RowRecord, firms: Map<number, FirmSummary>): BulkRowResponse => {
  const firm = row.firmId === null ? undefined : firms.get(row.firmId);
  return {
    id: row.id,
    rowNr: row.rowNr,
    input: { name: row.inputName, country: row.inputCountry, city: row.inputCity, fei: row.inputFei },
    status: row.status as BulkRowStatus,
    failed: searchFailed(row),
    score: scoreOf(row),
    firm: firm ? { id: firm.id, displayName: firm.displayName, countryCode: firm.countryCode } : null,
    facts: firm
      ? { fdaRefusals3y: firm.facts.fda_refusals_3y, importAlertRed: firm.facts.import_alert_red.length > 0, auFailed3y: firm.facts.au_failed_3y }
      : null,
    candidates: row.candidates as BulkCandidate[],
  };
};

const toResponse = (job: JobRow): BulkJobResponse => ({
  id: job.id,
  fileName: job.fileName,
  status: job.status as BulkJobStatus,
  total: job.total,
  processed: job.processed,
  createdAt: job.createdAt.toISOString(),
  finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
});

const toRowValues = (jobId: string, row: BulkInputRow): typeof bulkJobRow.$inferInsert => ({
  jobId,
  rowNr: row.rowNr,
  inputName: row.name,
  inputCountry: row.countryCode,
  inputCity: row.city,
  inputFei: row.fei,
});

/**
 * An account's bulk screening jobs (spec §8.4). The upload parses the file, then charges the account for every row and
 * inserts the job and its rows in one transaction (P6-D4): a refusal or a failure leaves no job and no charge.
 */
@Injectable()
export class BulkJobsService {
  private readonly logger = new Logger(BulkJobsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
    private readonly processor: BulkProcessor,
    private readonly firms: FirmProfileService,
    private readonly watchlist: WatchlistsService,
  ) {}

  /** Checks the plan, parses `body` as it streams in, stores the job and its rows, and starts the job once they are committed. */
  async upload(ctx: RequestContext, fileName: string, body: AsyncIterable<Buffer>): Promise<BulkJobResponse> {
    await this.entitlements.assertFeature(ctx.orgId, 'bulk');
    const { rows, delimiter } = await parseBulkCsv(body);
    const id = uuidv7();
    const job = await this.db.transaction(async (tx) => {
      // The conditional upsert makes two simultaneous uploads unable to pass the limit together (P6-D4).
      await this.entitlements.consume(ctx.orgId, 'bulk_rows', rows.length, tx);
      const [created] = await tx
        .insert(bulkJob)
        .values({ id, orgId: ctx.orgId, createdBy: ctx.userId, fileName, delimiter, total: rows.length })
        .returning();
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await tx.insert(bulkJobRow).values(rows.slice(i, i + INSERT_CHUNK).map((row) => toRowValues(id, row)));
      }
      return created;
    });
    this.start(id);
    return toResponse(job);
  }

  /** The account's newest jobs. Any of them whose worker is gone is started again, as `get` does; the answer is the jobs as read. */
  async list(ctx: RequestContext): Promise<BulkJobListResponse> {
    const found = await this.db
      .select({ job: bulkJob, stale: claimableJob() })
      .from(bulkJob)
      .where(byOrg(bulkJob, ctx))
      .orderBy(desc(bulkJob.createdAt), desc(bulkJob.id))
      .limit(LIST_LIMIT);
    for (const { job, stale } of found) if (stale) this.start(job.id);
    return { jobs: found.map(({ job }) => toResponse(job)) };
  }

  /**
   * One job of the account; another account's job is `404`, like one that is not there. A job whose worker is gone (its
   * heartbeat is stale, or it was never started) is started again (P6-D5); the answer is the job as it was read.
   */
  async get(ctx: RequestContext, id: string): Promise<BulkJobResponse> {
    const [found] = await this.db
      .select({ job: bulkJob, stale: claimableJob() })
      .from(bulkJob)
      .where(byOrg(bulkJob, ctx, eq(bulkJob.id, id)));
    if (!found) throw notFound();
    if (found.stale) this.start(id);
    return toResponse(found.job);
  }

  /**
   * One page of a job's rows by row number (P6-D9), optionally only those in `status`. A row with a firm carries the firm's
   * summary facts. A firm merged away after matching needs no lookup here: the merge re-points `bulk_job_row.firm_id`.
   */
  async rows(ctx: RequestContext, jobId: string, query: { status?: BulkRowStatus; cursor?: string }): Promise<BulkRowsResponse> {
    await this.job(ctx, jobId);
    const conditions: (SQL | undefined)[] = [eq(bulkJobRow.jobId, jobId)];
    if (query.status) conditions.push(eq(bulkJobRow.status, query.status));
    if (query.cursor) conditions.push(gt(bulkJobRow.rowNr, cursorRowNr(query.cursor)));
    // One row more than the page tells whether another page follows.
    const found = await this.db
      .select()
      .from(bulkJobRow)
      .where(and(...conditions))
      .orderBy(asc(bulkJobRow.rowNr))
      .limit(BULK_LIMITS.pageSize + 1);
    const page = found.slice(0, BULK_LIMITS.pageSize);
    const last = page[page.length - 1];
    const summaries = await this.firms.summaryFacts(distinctFirmIds(page));
    return {
      rows: page.map((row) => toRowResponse(row, summaries)),
      nextCursor: found.length > BULK_LIMITS.pageSize && last ? encodeCursor(ROW_CURSOR_DATE, last.rowNr) : null,
    };
  }

  /**
   * Confirms one of a row's candidates or rejects the row (P6-D7). A candidate whose firm was merged away since matching is
   * found by its surviving firm, because a merge re-points `firm_id` but not the ids inside `candidates`; the row then names
   * the survivor. A row still being processed is `409`.
   */
  async review(ctx: RequestContext, jobId: string, rowId: number, body: BulkRowReviewRequest): Promise<BulkRowResponse> {
    await this.job(ctx, jobId);
    const [row] = await this.db.select().from(bulkJobRow).where(and(eq(bulkJobRow.id, rowId), eq(bulkJobRow.jobId, jobId)));
    if (!row) throw notFound();
    if (row.status === 'pending') throw rowPending();

    let changes: Partial<typeof bulkJobRow.$inferInsert>;
    if (body.action === 'reject') {
      changes = { status: 'rejected', firmId: null };
    } else {
      const wanted = await this.firms.resolveId(body.firmId);
      let chosen: { firmId: number; score: number } | null = null;
      for (const candidate of row.candidates as BulkCandidate[]) {
        if (wanted !== null && (await this.firms.resolveId(candidate.firmId)) === wanted) {
          chosen = { firmId: wanted, score: candidate.score };
          break;
        }
      }
      if (chosen === null) throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_CANDIDATE', "That firm is not one of this row's candidates.");
      changes = { status: 'confirmed', firmId: chosen.firmId, score: chosen.score.toFixed(4) };
    }
    // The processor writes a row only while it is pending, so a row decided here is never overwritten by it.
    const [updated] = await this.db
      .update(bulkJobRow)
      .set(changes)
      .where(and(eq(bulkJobRow.id, rowId), sql`${bulkJobRow.status} <> 'pending'`))
      .returning();
    if (!updated) throw rowPending();
    const summaries = await this.firms.summaryFacts(distinctFirmIds([updated]));
    return toRowResponse(updated, summaries);
  }

  /** Adds the firms of the job's `matched` and `confirmed` rows to the account's watchlist, as far as the plan allows (P6-D8). */
  async watchConfirmed(ctx: RequestContext, jobId: string): Promise<WatchConfirmedResponse> {
    await this.job(ctx, jobId);
    // One item per firm, in row order, named by the first row that found it.
    const { rows } = await this.db.execute<{ firmId: string | number; inputName: string }>(sql`
      select firm_id as "firmId", (array_agg(input_name order by row_nr))[1] as "inputName"
      from bulk_job_row
      where job_id = ${jobId}::uuid and status in ('matched', 'confirmed') and firm_id is not null
      group by firm_id
      order by min(row_nr)`);
    return this.watchlist.addFirms(
      ctx,
      rows.map((row) => ({ firmId: Number(row.firmId), inputName: row.inputName })),
    );
  }

  /**
   * The finished job as CSV (P6-D9): a UTF-8 BOM, the header, then one line per row, each ending in CRLF. It is written with
   * the delimiter the upload used, so a file from Excel in a `;` locale opens there in columns again. A row whose search
   * failed every attempt reads `search_failed`, not `no_record`.
   */
  async exportCsv(ctx: RequestContext, jobId: string): Promise<string> {
    const job = await this.job(ctx, jobId);
    if (job.status !== 'finished') throw rowPending();
    const rows = await this.db.select().from(bulkJobRow).where(eq(bulkJobRow.jobId, jobId)).orderBy(asc(bulkJobRow.rowNr));
    const summaries = await this.firms.summaryFacts(distinctFirmIds(rows));
    const delimiter = job.delimiter as BulkDelimiter;
    const lines = rows.map((row) => {
      const firm = row.firmId === null ? undefined : summaries.get(row.firmId);
      const score = scoreOf(row);
      return toCsvRow([
        row.inputName,
        row.inputCountry,
        row.inputCity,
        row.inputFei,
        searchFailed(row) ? 'search_failed' : row.status,
        score === null ? null : score.toFixed(2),
        firm?.id ?? null,
        firm?.displayName ?? null,
        firm?.countryCode ?? null,
        firm?.facts.fda_refusals_3y ?? null,
        firm ? (firm.facts.import_alert_red.length > 0 ? 'yes' : 'no') : null,
        firm?.facts.au_failed_3y ?? null,
      ], delimiter);
    });
    return BOM + [toCsvRow(EXPORT_HEADER, delimiter), ...lines].map((line) => `${line}\r\n`).join('');
  }

  /** The account's job `id`; another account's job is `404`, like one that is not there. */
  private async job(ctx: RequestContext, id: string): Promise<JobRow> {
    const [job] = await this.db.select().from(bulkJob).where(byOrg(bulkJob, ctx, eq(bulkJob.id, id)));
    if (!job) throw notFound();
    return job;
  }

  /** The job is committed, so a failure to start it must not undo the answer: the next read or restart resumes it (P6-D5). */
  private start(jobId: string): void {
    try {
      this.processor.start(jobId);
    } catch (err) {
      this.logger.error({ jobId, err }, 'bulk_job_start_failed');
    }
  }
}
