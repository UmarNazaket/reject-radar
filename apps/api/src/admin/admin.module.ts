import { Module } from '@nestjs/common';
import { NoticesModule } from '../notices/notices.module';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

/** The staff admin area (P10); every controller is for platform admins only. */
@Module({
  imports: [NoticesModule],
  controllers: [SourcesController],
  providers: [SourcesService],
})
export class AdminModule {}
