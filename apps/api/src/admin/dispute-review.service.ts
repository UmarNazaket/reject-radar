import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AdminDisputeItem,
  ApiEnv,
  DecideDisputeRequest,
  DecideDisputeResponse,
  DisputeKind,
  DisputeReviewQuery,
  DisputeReviewResponse,
  DisputeStatus,
  FirmRecordSource,
  Locale,
} from '@rejectradar/contracts';
import { appUser, auditLog, type Database, dispute, org } from '@rejectradar/db';
import { renderEmail } from '@rejectradar/mail';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import { MailerService } from '../mail/mailer.service';
import { FirmToolsService } from './firm-tools.service';

const LIST_LIMIT = 100;

const columns = {
  dispute,
  orgName: org.name,
  reporterName: appUser.name,
  reporterEmail: appUser.email,
  reporterLocale: appUser.locale,
};

type Row = { dispute: typeof dispute.$inferSelect; orgName: string; reporterName: string | null; reporterEmail: string | null; reporterLocale: string | null };

/** The disputes customers file with "Report a problem" (P10): staff resolve or reject each once, and the reporter is emailed the note. */
@Injectable()
export class DisputeReviewService {
  private readonly logger = new Logger(DisputeReviewService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly firms: FirmToolsService,
    private readonly mailer: MailerService,
  ) {}

  async list(query: DisputeReviewQuery): Promise<DisputeReviewResponse> {
    const rows = await this.select()
      .where(eq(dispute.status, query.status))
      .orderBy(desc(dispute.createdAt), desc(dispute.id))
      .limit(LIST_LIMIT);
    return { items: await this.toItems(rows) };
  }

  async decide(ctx: RequestContext, id: string, body: DecideDisputeRequest): Promise<DecideDisputeResponse> {
    const decided = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(dispute)
        .set({ status: body.status, resolution: body.resolution, resolvedBy: ctx.userId, resolvedAt: sql`now()` })
        .where(and(eq(dispute.id, id), eq(dispute.status, 'open')))
        .returning({ id: dispute.id, firmId: dispute.firmId, orgId: dispute.orgId });
      if (updated.length === 0) return false;
      await tx.insert(auditLog).values({
        actorUserId: ctx.userId,
        action: body.status === 'resolved' ? 'dispute.resolve' : 'dispute.reject',
        targetType: 'dispute',
        targetId: id,
        details: { firmId: updated[0].firmId, orgId: updated[0].orgId },
      });
      return true;
    });
    const [row] = await this.select().where(eq(dispute.id, id));
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');
    if (!decided) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'This dispute was decided already.');
    const [item] = await this.toItems([row]);
    return { item, emailed: await this.email(row, item) };
  }

  private select() {
    return this.db.select(columns).from(dispute).innerJoin(org, eq(org.id, dispute.orgId)).leftJoin(appUser, eq(appUser.id, dispute.userId));
  }

  /** Tells the reporter, in their language, after the decision is stored; a failure is logged, never thrown, so it cannot undo the decision. */
  private async email(row: Row, item: AdminDisputeItem): Promise<boolean> {
    if (!row.reporterEmail || !row.reporterLocale || !row.dispute.userId) return false;
    try {
      const result = await this.mailer.send({
        kind: 'dispute_answered',
        to: row.reporterEmail,
        userId: row.dispute.userId,
        content: renderEmail(item.status === 'resolved' ? 'dispute_resolved' : 'dispute_rejected', row.reporterLocale as Locale, {
          firmName: item.firm.displayName,
          note: item.resolution ?? '',
          link: `${this.env.APP_ORIGIN}/firms/${item.firm.id}`,
        }),
      });
      return result === 'sent';
    } catch (error) {
      // Never the address. A reached cap arrives as an `AppError` with `EMAIL_CAP_REACHED`.
      const reason = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : error instanceof Error ? error.name : 'unknown';
      this.logger.warn({ disputeId: row.dispute.id, reason }, 'Dispute email was not sent');
      return false;
    }
  }

  private async toItems(rows: Row[]): Promise<AdminDisputeItem[]> {
    const firms = await this.firms.summaries(rows.map((r) => r.dispute.firmId));
    return rows.map(({ dispute: d, orgName, reporterName, reporterEmail }) => ({
      id: d.id,
      kind: d.kind as DisputeKind,
      message: d.message,
      status: d.status as DisputeStatus,
      resolution: d.resolution,
      firm: firms.get(d.firmId) as AdminDisputeItem['firm'],
      record: d.source && d.sourceKey ? { source: d.source as FirmRecordSource, key: d.sourceKey } : null,
      org: { id: d.orgId, name: orgName },
      reporter: reporterName !== null && reporterEmail !== null ? { name: reporterName, email: reporterEmail } : null,
      createdAt: d.createdAt.toISOString(),
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
    }));
  }
}
