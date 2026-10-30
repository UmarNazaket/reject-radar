import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  AdminFirmRecord,
  AdminFirmResponse,
  AdminFirmSummary,
  FirmChangeResponse,
  FirmRecordSource,
  MatchReviewItem,
  MatchReviewQuery,
  MatchReviewReason,
  MatchReviewsResponse,
  MatchReviewStatus,
  SplitFirmRequest,
} from '@rejectradar/contracts';
import { auditLog, type Database, matchReview } from '@rejectradar/db';
import { loadFirmRecords, mergeFirms, splitFirm } from '@rejectradar/entities';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';

const LIST_LIMIT = 100;

type FirmRow = { id: number; display_name: string; country_code: string | null; city: string | null; feis: string[]; records: number; merged_into: number | null };

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * The firm library refuses a merge or split it cannot do (one firm twice, a merged-away firm, a split of every record)
 * with a plain Error, written for staff; database errors carry a `code` and stay server errors.
 */
function refused(error: unknown): never {
  if (error instanceof Error && !('code' in error)) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', error.message);
  throw error;
}

/** Match review and the firm merge and split tools, for staff (P10). Merges and splits go through `libs/entities`. */
@Injectable()
export class FirmToolsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async reviews(query: MatchReviewQuery): Promise<MatchReviewsResponse> {
    const rows = await this.db
      .select()
      .from(matchReview)
      .where(eq(matchReview.status, query.status))
      .orderBy(desc(matchReview.createdAt), desc(matchReview.id))
      .limit(LIST_LIMIT);
    const firms = await this.summaries(rows.flatMap((r) => [r.firmId, r.candidateFirmId]));
    return { items: rows.map((row) => this.toItem(row, firms)) };
  }

  /** Same firm: merge the two, which marks this review and any other between them `linked`. Two firms: keep them apart. */
  async decide(ctx: RequestContext, id: number, same: boolean): Promise<MatchReviewItem> {
    const [review] = await this.db.select().from(matchReview).where(eq(matchReview.id, id));
    if (!review) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    if (review.status !== 'open') throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'This review was decided already.');
    if (same) {
      await mergeFirms(this.db, { firmIds: [review.firmId, review.candidateFirmId], actorUserId: ctx.userId, today: today() }).catch(refused);
    } else {
      await this.db.transaction(async (tx) => {
        const kept = await tx
          .update(matchReview)
          .set({ status: 'kept_separate', decidedBy: ctx.userId, decidedAt: sql`now()` })
          .where(and(eq(matchReview.id, id), eq(matchReview.status, 'open')))
          .returning({ id: matchReview.id });
        if (kept.length === 0) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'This review was decided already.');
        await tx.insert(auditLog).values({
          actorUserId: ctx.userId,
          action: 'match.keep_separate',
          targetType: 'match_review',
          targetId: String(id),
          details: { firmId: review.firmId, candidateFirmId: review.candidateFirmId },
        });
      });
    }
    const [row] = await this.db.select().from(matchReview).where(eq(matchReview.id, id));
    return this.toItem(row, await this.summaries([row.firmId, row.candidateFirmId]));
  }

  async firm(id: number): Promise<AdminFirmResponse> {
    const firms = await this.summaries([id]);
    const summary = firms.get(id);
    if (!summary) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    const loaded = await loadFirmRecords(this.db, { firmId: id });
    const records: AdminFirmRecord[] = loaded
      .map(({ record, rawAddress }) => ({
        source: record.source,
        key: record.key,
        fei: record.fei === null ? null : String(record.fei),
        firmName: record.firmName,
        address: rawAddress,
        seenOn: record.seenOn,
      }))
      .sort((a, b) => b.seenOn.localeCompare(a.seenOn));
    return { firm: summary, records };
  }

  async merge(ctx: RequestContext, firmIds: readonly [number, number]): Promise<FirmChangeResponse> {
    const result = await mergeFirms(this.db, { firmIds, actorUserId: ctx.userId, today: today() }).catch(refused);
    return { keptId: result.keptId, otherId: result.mergedId, moved: result.moved };
  }

  async split(ctx: RequestContext, id: number, body: SplitFirmRequest): Promise<FirmChangeResponse> {
    const result = await splitFirm(this.db, { firmId: id, records: body.records, actorUserId: ctx.userId, today: today() }).catch(refused);
    return { keptId: result.fromId, otherId: result.newFirmId, moved: result.moved };
  }

  /** The firms by id, with their FEIs, how many records they hold and where they were merged, if they were. */
  async summaries(ids: number[]): Promise<Map<number, AdminFirmSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const { rows } = await this.db.execute<FirmRow>(sql`
      select f.id, f.display_name, f.country_code, f.city,
        coalesce((select array_agg(fei::text order by fei) from firm_fei where firm_id = f.id), '{}') as feis,
        ((select count(*) from fda_refusal where firm_id = f.id)
          + (select count(*) from import_alert_listing where firm_id = f.id)
          + (select count(*) from au_failing_food where firm_id = f.id))::int as records,
        (select new_id from firm_alias where old_id = f.id) as merged_into
      from firm f
      where f.id in (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})`);
    return new Map(
      rows.map((r) => [
        Number(r.id),
        {
          id: Number(r.id),
          displayName: r.display_name,
          countryCode: r.country_code,
          city: r.city,
          feis: r.feis,
          records: r.records,
          mergedInto: r.merged_into === null ? null : Number(r.merged_into),
        },
      ]),
    );
  }

  private toItem(row: typeof matchReview.$inferSelect, firms: Map<number, AdminFirmSummary>): MatchReviewItem {
    return {
      id: row.id,
      source: row.source as FirmRecordSource,
      sourceKey: row.sourceKey,
      reason: row.reason as MatchReviewReason,
      score: Number(row.score),
      evidence: row.evidence as Record<string, unknown>,
      status: row.status as MatchReviewStatus,
      firm: firms.get(row.firmId) as AdminFirmSummary,
      candidate: firms.get(row.candidateFirmId) as AdminFirmSummary,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }
}
