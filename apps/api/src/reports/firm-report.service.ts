import { Inject, Injectable } from '@nestjs/common';
import type { FirmProfileResponse } from '@rejectradar/contracts';
import { type Database, org } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { RequestContext } from '../auth/context';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { FirmProfileService } from '../firms/firm-profile.service';
import { firmReportDoc } from './firm-report.doc';
import { PdfRenderer } from './pdf-renderer';

/** The one-page firm PDF (spec §9.9, P6-D12). */
@Injectable()
export class FirmReportService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
    private readonly profiles: FirmProfileService,
    private readonly renderer: PdfRenderer,
  ) {}

  /**
   * The report's document and the profile it is made from. The plan is checked first, so an account without PDFs is
   * never charged; the profile then charges the lookup on the same terms as opening it (a firm already opened this
   * month is free, a merged-away id is followed, an unknown firm is 404).
   */
  async document(ctx: Pick<RequestContext, 'orgId'>, firmId: number): Promise<{ doc: TDocumentDefinitions; profile: FirmProfileResponse }> {
    await this.entitlements.assertFeature(ctx.orgId, 'pdf');
    const profile = await this.profiles.profile(ctx, firmId);
    const [account] = await this.db.select({ name: org.name }).from(org).where(eq(org.id, ctx.orgId));
    const doc = firmReportDoc({ orgName: account?.name ?? '', profile, generatedAt: new Date().toISOString().slice(0, 10) });
    return { doc, profile };
  }

  /** The PDF and its file name, which carries the surviving firm's id. */
  async build(ctx: Pick<RequestContext, 'orgId'>, firmId: number): Promise<{ fileName: string; pdf: Buffer }> {
    const { doc, profile } = await this.document(ctx, firmId);
    return { fileName: `rejectradar-firm-${profile.id}.pdf`, pdf: await this.renderer.render('firm', doc) };
  }
}
