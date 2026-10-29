import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  importAlertNumberSchema,
  type ReviewSummaryRequest,
  reviewSummaryRequest,
  type SummaryReviewItem,
  type SummaryReviewQuery,
  type SummaryReviewResponse,
  summaryReviewQuery,
} from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, PlatformAdmin } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-pipe';
import { SummaryReviewService } from './summary-review.service';

/** The review of the English Import Alert summaries Gemini drafts, by RejectRadar staff. The screens come with the admin panel (P10). */
@Controller('admin/import-alert-summaries')
@PlatformAdmin()
export class SummaryReviewController {
  constructor(private readonly review: SummaryReviewService) {}

  @Get()
  list(@Query(new ZodValidationPipe(summaryReviewQuery)) query: SummaryReviewQuery): Promise<SummaryReviewResponse> {
    return this.review.list(query);
  }

  @Patch(':number')
  decide(
    @CurrentContext() ctx: RequestContext,
    @Param('number', new ZodValidationPipe(importAlertNumberSchema)) number: string,
    @Body(new ZodValidationPipe(reviewSummaryRequest)) body: ReviewSummaryRequest,
  ): Promise<SummaryReviewItem> {
    return this.review.review(ctx, number, body);
  }
}
