import { Controller, Get } from '@nestjs/common';
import type { AdminSourcesResponse } from '@rejectradar/contracts';
import { PlatformAdmin, RequireVerifiedEmail } from '../auth/decorators';
import { SourcesService } from './sources.service';

/** Source health for RejectRadar staff (P10). */
@Controller('admin/sources')
@PlatformAdmin()
@RequireVerifiedEmail()
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  list(): Promise<AdminSourcesResponse> {
    return this.sources.all();
  }
}
