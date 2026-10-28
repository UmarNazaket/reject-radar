import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { NoticesModule } from '../notices/notices.module';
import { DisputesService } from './disputes.service';
import { FirmProfileService } from './firm-profile.service';
import { FirmSearchService } from './firm-search.service';
import { FirmsController } from './firms.controller';

@Module({
  imports: [EntitlementsModule, NoticesModule],
  controllers: [FirmsController],
  providers: [FirmSearchService, FirmProfileService, DisputesService],
  exports: [FirmSearchService, FirmProfileService],
})
export class FirmsModule {}
