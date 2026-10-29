import { Inject, Injectable } from '@nestjs/common';
import type { DashboardQuery, DashboardResponse } from '@rejectradar/contracts';
import { type Database, org } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { RequestContext } from '../auth/context';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { DashboardsService } from '../notices/dashboards.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { PdfRenderer } from './pdf-renderer';
import { topicReportDoc } from './topic-report.doc';

/** A country's English name from its ISO code; the code itself when ICU does not know it. */
const countryName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** The file name of a topic report: `rejectradar-topic-<origin>-<commodity id or all>-<destinations joined by + or all>.pdf`, lower-cased. */
export function topicFileName(query: DashboardQuery): string {
  const commodity = query.commodity === undefined ? 'all' : String(query.commodity);
  const destinations = query.destination === undefined ? 'all' : query.destination.join('+');
  // The query is validated (two capital letters, digits, the four destination codes), so nothing here needs quoting.
  return `rejectradar-topic-${query.origin}-${commodity}-${destinations}.pdf`.toLowerCase();
}

/** The one-page topic PDF (spec §9.9, P6-D12): the dashboard's figures, no lookup. */
@Injectable()
export class TopicReportService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
    private readonly dashboards: DashboardsService,
    private readonly taxonomy: TaxonomyService,
    private readonly renderer: PdfRenderer,
  ) {}

  /**
   * The report's document and the dashboard answer it is made from. The plan is checked first; the dashboard then applies
   * the plan's history window, so the report shows what `GET /v1/dashboards/topic` shows for the same query.
   */
  async document(
    ctx: Pick<RequestContext, 'orgId'>,
    query: DashboardQuery,
  ): Promise<{ doc: TDocumentDefinitions; dashboard: DashboardResponse }> {
    await this.entitlements.assertFeature(ctx.orgId, 'pdf');
    const [dashboard, labels, [account]] = await Promise.all([
      this.dashboards.topic(ctx.orgId, query),
      this.taxonomy.labels('en'),
      this.db.select({ name: org.name }).from(org).where(eq(org.id, ctx.orgId)),
    ]);
    const doc = topicReportDoc({
      orgName: account?.name ?? '',
      generatedAt: new Date().toISOString().slice(0, 10),
      query,
      originName: countryName(query.origin),
      commodityName: query.commodity === undefined ? null : (labels.commodities.find((c) => c.id === query.commodity)?.label ?? null),
      hazardNames: Object.fromEntries(labels.hazards.map((h) => [h.id, h.label])),
      dashboard,
    });
    return { doc, dashboard };
  }

  /** The PDF and its file name. */
  async build(ctx: Pick<RequestContext, 'orgId'>, query: DashboardQuery): Promise<{ fileName: string; pdf: Buffer }> {
    const { doc } = await this.document(ctx, query);
    return { fileName: topicFileName(query), pdf: await this.renderer.render('topic', doc) };
  }
}
