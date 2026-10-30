import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { NoticesModule } from '../notices/notices.module';
import { OrgsModule } from '../orgs/orgs.module';
import { WatchlistsModule } from '../watchlists/watchlists.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { DisputeReviewController } from './dispute-review.controller';
import { DisputeReviewService } from './dispute-review.service';
import { FirmToolsController } from './firm-tools.controller';
import { FirmToolsService } from './firm-tools.service';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';
import { TaxonomyRulesController } from './taxonomy-rules.controller';
import { TaxonomyRulesService } from './taxonomy-rules.service';

/** The staff admin area (P10); every controller is for platform admins only. */
@Module({
  imports: [EntitlementsModule, NoticesModule, OrgsModule, WatchlistsModule],
  controllers: [SourcesController, FirmToolsController, DisputeReviewController, TaxonomyRulesController, AccountsController],
  providers: [SourcesService, FirmToolsService, DisputeReviewService, TaxonomyRulesService, AccountsService],
})
export class AdminModule {}
