import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { type DashboardQuery, dashboardQuery } from '@rejectradar/contracts';
import type { Response } from 'express';
import type { RequestContext } from '../auth/context';
import { CurrentContext, RequireVerifiedEmail } from '../auth/decorators';
import { PositiveIntParamPipe } from '../common/int-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { FirmReportService } from './firm-report.service';
import { TopicReportService } from './topic-report.service';

/**
 * PDF reports (spec §9.9). The firm report lives under `firms/` like the profile, but in its own controller: `ReportsModule`
 * imports `FirmsModule` for the profile, so a route in `FirmsController` would make the two modules import each other.
 * `firms/:id` and `firms/:id/report.pdf` are different paths, so neither controller swallows the other's route. The topic
 * report is here for the same reason: `ReportsModule` imports `NoticesModule` for the dashboard, which must not import it back.
 */
@Controller()
export class ReportsController {
  constructor(
    private readonly firmReports: FirmReportService,
    private readonly topicReports: TopicReportService,
  ) {}

  /** A PDF needs a plan with PDFs and, like the profile it is made from, a verified email. */
  @Get('firms/:id/report.pdf')
  @RequireVerifiedEmail()
  async firm(
    @CurrentContext() ctx: RequestContext,
    @Param('id', new PositiveIntParamPipe()) id: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // The headers are set only once the PDF exists, so a refusal (403) or a 404 is still a JSON error.
    const { fileName, pdf } = await this.firmReports.build(ctx, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(pdf);
  }

  /** The topic dashboard as a PDF: the dashboard's own query, a plan with PDFs, and no lookup. */
  @Get('dashboards/topic/report.pdf')
  async topic(
    @CurrentContext() ctx: RequestContext,
    @Query(new ZodValidationPipe(dashboardQuery)) query: DashboardQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { fileName, pdf } = await this.topicReports.build(ctx, query);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(pdf);
  }
}
