import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  type CreateDisputeRequest,
  createDisputeRequest,
  type DisputeResponse,
  type FirmProfileResponse,
  type FirmSearchQuery,
  type FirmSearchResponse,
  firmSearchQuery,
} from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, RequireVerifiedEmail } from '../auth/decorators';
import { PositiveIntParamPipe } from '../common/int-param.pipe';
import { RateLimit } from '../common/rate-limit';
import { ZodValidationPipe } from '../common/zod-pipe';
import { DisputesService } from './disputes.service';
import { FirmProfileService } from './firm-profile.service';
import { FirmSearchService } from './firm-search.service';

const HOUR_MS = 3_600_000;

/** Firms. Declare static routes (`search`) before any `:id` route, or the parameter swallows them. */
@Controller('firms')
export class FirmsController {
  constructor(
    private readonly search: FirmSearchService,
    private readonly profiles: FirmProfileService,
    private readonly disputes: DisputesService,
  ) {}

  /** Any signed-in user may search, verified or not; searching uses no lookup. */
  @Get('search')
  @RateLimit({ name: 'firm-search', limit: 30, windowMs: 60_000, key: 'user' })
  find(@Query(new ZodValidationPipe(firmSearchQuery)) query: FirmSearchQuery): Promise<FirmSearchResponse> {
    return this.search.search(query);
  }

  /** Opening a profile uses a lookup (P5-D2), so only verified users may. A merged-away id answers with the surviving firm (P5-D9). */
  @Get(':id')
  @RequireVerifiedEmail()
  profile(@CurrentContext() ctx: RequestContext, @Param('id', new PositiveIntParamPipe()) id: number): Promise<FirmProfileResponse> {
    return this.profiles.profile(ctx, id);
  }

  @Post(':id/disputes')
  @RequireVerifiedEmail()
  @RateLimit({ name: 'dispute', limit: 10, windowMs: HOUR_MS, key: 'user' })
  dispute(
    @CurrentContext() ctx: RequestContext,
    @Param('id', new PositiveIntParamPipe()) id: number,
    @Body(new ZodValidationPipe(createDisputeRequest)) body: CreateDisputeRequest,
  ): Promise<DisputeResponse> {
    return this.disputes.create(ctx, id, body);
  }
}
