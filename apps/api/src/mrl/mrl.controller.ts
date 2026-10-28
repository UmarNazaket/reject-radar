import { Controller, Get, Query } from '@nestjs/common';
import {
  type MrlQuery,
  type MrlResponse,
  mrlQuery,
  type ResidueSearchQuery,
  type ResidueSearchResponse,
  residueSearchQuery,
} from '@rejectradar/contracts';
import { ZodValidationPipe } from '../common/zod-pipe';
import { MrlService } from './mrl.service';

/** The EU MRL checker. Any signed-in user may use it; it is reference data and uses no lookup. */
@Controller('mrl')
export class MrlController {
  constructor(private readonly mrl: MrlService) {}

  @Get('residues')
  residues(@Query(new ZodValidationPipe(residueSearchQuery)) query: ResidueSearchQuery): Promise<ResidueSearchResponse> {
    return this.mrl.searchResidues(query.q);
  }

  @Get()
  check(@Query(new ZodValidationPipe(mrlQuery)) query: MrlQuery): Promise<MrlResponse> {
    return this.mrl.check(query);
  }
}
