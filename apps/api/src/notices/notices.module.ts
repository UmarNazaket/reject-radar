import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { FreshnessService } from './freshness.service';
import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';

@Module({
  imports: [EntitlementsModule],
  controllers: [NoticesController],
  providers: [NoticesService, FreshnessService],
  exports: [NoticesService, FreshnessService],
})
export class NoticesModule {}
