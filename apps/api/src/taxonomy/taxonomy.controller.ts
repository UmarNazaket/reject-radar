import { Controller, Get, Query } from '@nestjs/common';
import { type TaxonomyQuery, type TaxonomyResponse, taxonomyQuery } from '@rejectradar/contracts';
import { Public } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-pipe';
import { TaxonomyService } from './taxonomy.service';

/** Reference data for the filters and forms; the same for every caller, so it needs no session (P5-D4). */
@Public()
@Controller('taxonomy')
export class TaxonomyController {
  constructor(private readonly taxonomy: TaxonomyService) {}

  @Get()
  get(@Query(new ZodValidationPipe(taxonomyQuery)) query: TaxonomyQuery): Promise<TaxonomyResponse> {
    return this.taxonomy.labels(query.locale);
  }
}
