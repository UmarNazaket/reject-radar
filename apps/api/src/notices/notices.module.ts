import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { DashboardsController } from './dashboards.controller';
import { DashboardsService } from './dashboards.service';
import { FreshnessService } from './freshness.service';
import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';

@Module({
  imports: [EntitlementsModule],
  controllers: [NoticesController, DashboardsController],
  providers: [NoticesService, FreshnessService, DashboardsService],
  exports: [NoticesService, FreshnessService, DashboardsService],
})
export class NoticesModule {}
