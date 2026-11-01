import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { FirmsModule } from '../firms/firms.module';
import { ImportAlertsModule } from '../import-alerts/import-alerts.module';
import { MrlModule } from '../mrl/mrl.module';
import { NoticesModule } from '../notices/notices.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { ApiQuotaInterceptor } from './api-quota.interceptor';
import { PublicApiController, PublicUsageController } from './public-api.controller';

@Module({
  imports: [EntitlementsModule, FirmsModule, ImportAlertsModule, MrlModule, NoticesModule, TaxonomyModule],
  controllers: [PublicApiController, PublicUsageController],
  providers: [ApiQuotaInterceptor],
})
export class PublicApiModule {}
