import { Module } from '@nestjs/common';
import { FirmSearchService } from './firm-search.service';
import { FirmsController } from './firms.controller';

@Module({
  controllers: [FirmsController],
  providers: [FirmSearchService],
  exports: [FirmSearchService],
})
export class FirmsModule {}
