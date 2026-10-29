import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  importAlertEnglishSummaryContentSchema,
  type ImportAlertSummaryContent,
  type ReviewSummaryRequest,
  type SummaryReviewItem,
  type SummaryReviewQuery,
  type SummaryReviewResponse,
  type SummaryStatus,
} from '@rejectradar/contracts';
import { auditLog, type Database, importAlert, importAlertSummary } from '@rejectradar/db';
import { and, desc, eq, ne, type SQL, sql } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';

/** The most summaries a review list returns; the queue is a few hundred food alerts at most. */
const LIST_LIMIT = 200;

/** The summary's alert text matches the alert's current text. */
const current = sql<boolean>`${importAlertSummary.sourceSha256} = ${importAlert.textSha256}`;

/**
 * The review of English Import Alert summaries by RejectRadar staff (spec §9.10). Only an approved summary of the alert's
 * current text is ever served; approving one drops its translations, which `summaries:translate` then makes again.
 */
@Injectable()
export class SummaryReviewService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(query: SummaryReviewQuery): Promise<SummaryReviewResponse> {
    return { items: await this.load(eq(importAlertSummary.status, query.status), LIST_LIMIT) };
  }

  async review(ctx: RequestContext, number: string, body: ReviewSummaryRequest): Promise<SummaryReviewItem> {
    await this.db.transaction(async (tx) => {
      const english = and(eq(importAlertSummary.alertNumber, number), eq(importAlertSummary.locale, 'en'));
      const [row] = await tx
        .select({ content: importAlertSummary.content, current })
        .from(importAlertSummary)
        .innerJoin(importAlert, eq(importAlert.number, importAlertSummary.alertNumber))
        .where(english)
        .for('update', { of: importAlertSummary });
      if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
      const reviewed = { reviewedBy: ctx.userId, reviewedAt: sql`now()`, updatedAt: sql`now()` };

      if (body.action === 'reject') {
        await tx.update(importAlertSummary).set({ status: 'rejected', ...reviewed }).where(english);
      } else {
        if (!row.current) throw new AppError(HttpStatus.CONFLICT, 'SUMMARY_STALE', 'The alert text changed after this summary was drafted.');
        const content = importAlertEnglishSummaryContentSchema.safeParse(body.content ?? row.content);
        if (!content.success) throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'The stored summary is not valid; send corrected content.');
        await tx.update(importAlertSummary).set({ status: 'approved', content: content.data, ...reviewed }).where(english);
        // The translations were made from earlier English, or an earlier text; they are made again from this one.
        await tx.delete(importAlertSummary).where(and(eq(importAlertSummary.alertNumber, number), ne(importAlertSummary.locale, 'en')));
      }
      await tx.insert(auditLog).values({
        actorUserId: ctx.userId,
        action: `import_alert_summary.${body.action === 'reject' ? 'rejected' : 'approved'}`,
        targetType: 'import_alert_summary',
        targetId: number,
        details: body.action === 'approve' ? { edited: body.content !== undefined } : {},
      });
    });

    const [item] = await this.load(eq(importAlertSummary.alertNumber, number), 1);
    return item;
  }

  /** English summaries beside their alert text, newest first. */
  private async load(where: SQL, limit: number): Promise<SummaryReviewItem[]> {
    const rows = await this.db
      .select({
        number: importAlert.number,
        title: importAlert.title,
        reasonText: importAlert.reasonText,
        guidanceText: importAlert.guidanceText,
        productText: importAlert.productText,
        chargeText: importAlert.chargeText,
        url: importAlert.url,
        status: importAlertSummary.status,
        content: importAlertSummary.content,
        model: importAlertSummary.model,
        current,
        reviewedBy: importAlertSummary.reviewedBy,
        reviewedAt: importAlertSummary.reviewedAt,
        updatedAt: importAlertSummary.updatedAt,
      })
      .from(importAlertSummary)
      .innerJoin(importAlert, eq(importAlert.number, importAlertSummary.alertNumber))
      .where(and(eq(importAlertSummary.locale, 'en'), where))
      .orderBy(desc(importAlertSummary.updatedAt))
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      status: row.status as SummaryStatus,
      content: row.content as ImportAlertSummaryContent,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
