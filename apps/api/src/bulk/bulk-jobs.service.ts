import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { BulkJobListResponse, BulkJobResponse, BulkJobStatus } from '@rejectradar/contracts';
import { type Database, bulkJob, bulkJobRow, uuidv7 } from '@rejectradar/db';
import { desc, eq } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { toCsvRow } from '../common/csv';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
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

type JobRow = typeof bulkJob.$inferSelect;

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
  ) {}

  /** Checks the plan, parses `body` as it streams in, stores the job and its rows, and starts the job once they are committed. */
  async upload(ctx: RequestContext, fileName: string, body: AsyncIterable<Buffer>): Promise<BulkJobResponse> {
    await this.entitlements.assertFeature(ctx.orgId, 'bulk');
    const rows = await parseBulkCsv(body);
    const id = uuidv7();
    const job = await this.db.transaction(async (tx) => {
      // The conditional upsert makes two simultaneous uploads unable to pass the limit together (P6-D4).
      await this.entitlements.consume(ctx.orgId, 'bulk_rows', rows.length, tx);
      const [created] = await tx
        .insert(bulkJob)
        .values({ id, orgId: ctx.orgId, createdBy: ctx.userId, fileName, total: rows.length })
        .returning();
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await tx.insert(bulkJobRow).values(rows.slice(i, i + INSERT_CHUNK).map((row) => toRowValues(id, row)));
      }
      return created;
    });
    this.start(id);
    return toResponse(job);
  }

  /** The account's newest jobs. */
  async list(ctx: RequestContext): Promise<BulkJobListResponse> {
    const jobs = await this.db
      .select()
      .from(bulkJob)
      .where(byOrg(bulkJob, ctx))
      .orderBy(desc(bulkJob.createdAt), desc(bulkJob.id))
      .limit(LIST_LIMIT);
    return { jobs: jobs.map(toResponse) };
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
    if (!found) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    if (found.stale) this.start(id);
    return toResponse(found.job);
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
