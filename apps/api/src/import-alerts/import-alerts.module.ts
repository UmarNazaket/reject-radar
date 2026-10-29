import { Module } from '@nestjs/common';
import { ImportAlertsController } from './import-alerts.controller';
import { ImportAlertsService } from './import-alerts.service';
import { SummaryReviewController } from './summary-review.controller';
import { SummaryReviewService } from './summary-review.service';

@Module({
  controllers: [ImportAlertsController, SummaryReviewController],
  providers: [ImportAlertsService, SummaryReviewService],
  exports: [ImportAlertsService],
})
export class ImportAlertsModule {}
