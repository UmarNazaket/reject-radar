import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  type AdminFirmResponse,
  type FirmChangeResponse,
  type MatchDecisionRequest,
  matchDecisionRequest,
  type MatchReviewItem,
  type MatchReviewQuery,
  matchReviewQuery,
  type MatchReviewsResponse,
  type MergeFirmsRequest,
  mergeFirmsRequest,
  type SplitFirmRequest,
  splitFirmRequest,
} from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, PlatformAdmin, RequireVerifiedEmail } from '../auth/decorators';
import { PositiveIntParamPipe } from '../common/int-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { FirmToolsService } from './firm-tools.service';

/** Match review and the firm merge and split tools, for RejectRadar staff (P10). */
@Controller('admin')
@PlatformAdmin()
@RequireVerifiedEmail()
export class FirmToolsController {
  constructor(private readonly tools: FirmToolsService) {}

  @Get('match-reviews')
  reviews(@Query(new ZodValidationPipe(matchReviewQuery)) query: MatchReviewQuery): Promise<MatchReviewsResponse> {
    return this.tools.reviews(query);
  }

  @Post('match-reviews/:id/decision')
  @HttpCode(HttpStatus.OK)
  decide(
    @CurrentContext() ctx: RequestContext,
    @Param('id', PositiveIntParamPipe) id: number,
    @Body(new ZodValidationPipe(matchDecisionRequest)) body: MatchDecisionRequest,
  ): Promise<MatchReviewItem> {
    return this.tools.decide(ctx, id, body.same);
  }

  @Get('firms/:id')
  firm(@Param('id', PositiveIntParamPipe) id: number): Promise<AdminFirmResponse> {
    return this.tools.firm(id);
  }

  @Post('firms/merge')
  @HttpCode(HttpStatus.OK)
  merge(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(mergeFirmsRequest)) body: MergeFirmsRequest): Promise<FirmChangeResponse> {
    return this.tools.merge(ctx, body.firmIds);
  }

  @Post('firms/:id/split')
  @HttpCode(HttpStatus.OK)
  split(
    @CurrentContext() ctx: RequestContext,
    @Param('id', PositiveIntParamPipe) id: number,
    @Body(new ZodValidationPipe(splitFirmRequest)) body: SplitFirmRequest,
  ): Promise<FirmChangeResponse> {
    return this.tools.split(ctx, id, body);
  }
}
