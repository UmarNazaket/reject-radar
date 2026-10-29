import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { FirmsModule } from '../firms/firms.module';
import { BulkJobsController } from './bulk-jobs.controller';
import { BulkJobsService } from './bulk-jobs.service';
import { BulkProcessor } from './bulk-processor';

@Module({
  imports: [EntitlementsModule, FirmsModule],
  controllers: [BulkJobsController],
  providers: [BulkJobsService, BulkProcessor],
  exports: [BulkJobsService, BulkProcessor],
})
export class BulkModule {}
