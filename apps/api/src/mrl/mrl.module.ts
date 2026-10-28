import { Module } from '@nestjs/common';
import { MrlController } from './mrl.controller';
import { MrlService } from './mrl.service';

@Module({
  controllers: [MrlController],
  providers: [MrlService],
  exports: [MrlService],
})
export class MrlModule {}
