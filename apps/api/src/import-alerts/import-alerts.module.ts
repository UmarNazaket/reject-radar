import { Module } from '@nestjs/common';
import { ImportAlertsController } from './import-alerts.controller';
import { ImportAlertsService } from './import-alerts.service';

@Module({
  controllers: [ImportAlertsController],
  providers: [ImportAlertsService],
  exports: [ImportAlertsService],
})
export class ImportAlertsModule {}
