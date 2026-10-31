import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { type AlertItem, type AlertsQuery, alertsQuery, type AlertsResponse, type MarkReadRequest, markReadRequest, type MarkReadResponse } from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext } from '../auth/decorators';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { AlertsService } from './alerts.service';

/** The account's in-app alerts. Any signed-in user of the account may read them and mark them read. */
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(@CurrentContext() ctx: RequestContext, @Query(new ZodValidationPipe(alertsQuery)) query: AlertsQuery): Promise<AlertsResponse> {
    return this.alerts.list(ctx, query);
  }

  @Get(':id')
  get(@CurrentContext() ctx: RequestContext, @Param('id', new UuidParamPipe()) id: string): Promise<AlertItem> {
    return this.alerts.get(ctx, id);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  markRead(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(markReadRequest)) body: MarkReadRequest): Promise<MarkReadResponse> {
    return this.alerts.markRead(ctx, body);
  }
}
