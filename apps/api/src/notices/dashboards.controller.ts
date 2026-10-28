import { Controller, Get, Query } from '@nestjs/common';
import { type DashboardQuery, type DashboardResponse, dashboardQuery } from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-pipe';
import { DashboardsService } from './dashboards.service';

/** Dashboards over the notices. Any signed-in user may; the plan sets how far back they reach. */
@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  @Get('topic')
  topic(
    @CurrentContext() ctx: RequestContext,
    @Query(new ZodValidationPipe(dashboardQuery)) query: DashboardQuery,
  ): Promise<DashboardResponse> {
    return this.dashboards.topic(ctx.orgId, query);
  }
}
