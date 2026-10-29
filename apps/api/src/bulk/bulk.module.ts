import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { BulkJobsController } from './bulk-jobs.controller';
import { BulkJobsService } from './bulk-jobs.service';
import { BulkProcessor } from './bulk-processor';

@Module({
  imports: [EntitlementsModule],
  controllers: [BulkJobsController],
  providers: [BulkJobsService, BulkProcessor],
  exports: [BulkJobsService, BulkProcessor],
})
export class BulkModule {}
