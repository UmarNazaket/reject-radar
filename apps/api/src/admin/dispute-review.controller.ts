import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  type DecideDisputeRequest,
  decideDisputeRequest,
  type DecideDisputeResponse,
  type DisputeReviewQuery,
  disputeReviewQuery,
  type DisputeReviewResponse,
} from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, PlatformAdmin, RequireVerifiedEmail } from '../auth/decorators';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { DisputeReviewService } from './dispute-review.service';

/** The disputes customers file with "Report a problem", for RejectRadar staff (P10). */
@Controller('admin/disputes')
@PlatformAdmin()
@RequireVerifiedEmail()
export class DisputeReviewController {
  constructor(private readonly disputes: DisputeReviewService) {}

  @Get()
  list(@Query(new ZodValidationPipe(disputeReviewQuery)) query: DisputeReviewQuery): Promise<DisputeReviewResponse> {
    return this.disputes.list(query);
  }

  @Patch(':id')
  decide(
    @CurrentContext() ctx: RequestContext,
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new ZodValidationPipe(decideDisputeRequest)) body: DecideDisputeRequest,
  ): Promise<DecideDisputeResponse> {
    return this.disputes.decide(ctx, id, body);
  }
}
