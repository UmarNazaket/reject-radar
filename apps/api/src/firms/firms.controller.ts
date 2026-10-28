import { Controller, Get, Query } from '@nestjs/common';
import { type FirmSearchQuery, type FirmSearchResponse, firmSearchQuery } from '@rejectradar/contracts';
import { RateLimit } from '../common/rate-limit';
import { ZodValidationPipe } from '../common/zod-pipe';
import { FirmSearchService } from './firm-search.service';

/** Firms. Declare static routes (`search`) before any `:id` route, or the parameter swallows them. */
@Controller('firms')
export class FirmsController {
  constructor(private readonly search: FirmSearchService) {}

  /** Any signed-in user may search, verified or not; searching uses no lookup. */
  @Get('search')
  @RateLimit({ name: 'firm-search', limit: 30, windowMs: 60_000, key: 'user' })
  find(@Query(new ZodValidationPipe(firmSearchQuery)) query: FirmSearchQuery): Promise<FirmSearchResponse> {
    return this.search.search(query);
  }
}
