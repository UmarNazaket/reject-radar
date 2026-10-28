import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type CreateWatchlistItemRequest,
  createWatchlistItemRequest,
  type TopicEstimateQuery,
  type TopicEstimateResponse,
  topicEstimateQuery,
  type UpdateWatchlistItemRequest,
  updateWatchlistItemRequest,
  type WatchlistItem,
  type WatchlistResponse,
} from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, RequireVerifiedEmail } from '../auth/decorators';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { WatchlistsService } from './watchlists.service';

/**
 * The account's watchlist. Reading is open to any signed-in user; adding, changing and removing need a verified email
 * (P5-D15), so alert emails go only to verified inboxes. Declare static routes (`export.csv`, `topic-estimate`) before `:id`.
 */
@Controller('watchlist')
export class WatchlistsController {
  constructor(private readonly watchlist: WatchlistsService) {}

  @Get()
  list(@CurrentContext() ctx: RequestContext): Promise<WatchlistResponse> {
    return this.watchlist.list(ctx);
  }

  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="rejectradar-watchlist.csv"')
  exportCsv(@CurrentContext() ctx: RequestContext): Promise<string> {
    return this.watchlist.exportCsv(ctx);
  }

  @Get('topic-estimate')
  estimate(@CurrentContext() ctx: RequestContext, @Query(new ZodValidationPipe(topicEstimateQuery)) topic: TopicEstimateQuery): Promise<TopicEstimateResponse> {
    return this.watchlist.estimate(ctx, topic);
  }

  @Post()
  @RequireVerifiedEmail()
  add(
    @CurrentContext() ctx: RequestContext,
    @Body(new ZodValidationPipe(createWatchlistItemRequest)) body: CreateWatchlistItemRequest,
  ): Promise<WatchlistItem> {
    return this.watchlist.add(ctx, body);
  }

  @Patch(':id')
  @RequireVerifiedEmail()
  update(
    @CurrentContext() ctx: RequestContext,
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new ZodValidationPipe(updateWatchlistItemRequest)) body: UpdateWatchlistItemRequest,
  ): Promise<WatchlistItem> {
    return this.watchlist.update(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireVerifiedEmail()
  async remove(@CurrentContext() ctx: RequestContext, @Param('id', new UuidParamPipe()) id: string): Promise<void> {
    await this.watchlist.remove(ctx, id);
  }
}
