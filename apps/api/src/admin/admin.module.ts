import { Module } from '@nestjs/common';
import { NoticesModule } from '../notices/notices.module';
import { DisputeReviewController } from './dispute-review.controller';
import { DisputeReviewService } from './dispute-review.service';
import { FirmToolsController } from './firm-tools.controller';
import { FirmToolsService } from './firm-tools.service';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

/** The staff admin area (P10); every controller is for platform admins only. */
@Module({
  imports: [NoticesModule],
  controllers: [SourcesController, FirmToolsController, DisputeReviewController],
  providers: [SourcesService, FirmToolsService, DisputeReviewService],
})
export class AdminModule {}
