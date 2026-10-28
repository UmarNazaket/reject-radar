import { Controller, Get, Param, Query } from '@nestjs/common';
import { type NoticeItem, type NoticeSearchQuery, type NoticeSearchResponse, noticeSearchQuery } from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext } from '../auth/decorators';
import { PositiveIntParamPipe } from '../common/int-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { NoticesService } from './notices.service';

/** Search and read the unified notices. Any signed-in user may (searching uses no lookup); the plan sets how far back. */
@Controller('notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  search(
    @CurrentContext() ctx: RequestContext,
    @Query(new ZodValidationPipe(noticeSearchQuery)) query: NoticeSearchQuery,
  ): Promise<NoticeSearchResponse> {
    return this.notices.search(ctx.orgId, query);
  }

  @Get(':id')
  get(@CurrentContext() ctx: RequestContext, @Param('id', new PositiveIntParamPipe()) id: number): Promise<NoticeItem> {
    return this.notices.get(ctx.orgId, id);
  }
}
