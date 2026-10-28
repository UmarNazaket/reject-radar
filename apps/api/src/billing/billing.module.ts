import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { OrgsModule } from '../orgs/orgs.module';
import { WatchlistsModule } from '../watchlists/watchlists.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({
  imports: [EntitlementsModule, OrgsModule, WatchlistsModule],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
