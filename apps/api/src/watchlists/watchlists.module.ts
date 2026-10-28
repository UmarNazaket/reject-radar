import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { FirmsModule } from '../firms/firms.module';
import { NoticesModule } from '../notices/notices.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { WatchlistsController } from './watchlists.controller';
import { WatchlistsService } from './watchlists.service';

@Module({
  imports: [EntitlementsModule, FirmsModule, NoticesModule, TaxonomyModule],
  controllers: [WatchlistsController],
  providers: [WatchlistsService],
  exports: [WatchlistsService],
})
export class WatchlistsModule {}
