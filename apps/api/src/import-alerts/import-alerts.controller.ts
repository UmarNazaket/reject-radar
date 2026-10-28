import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  type ImportAlertQuery,
  type ImportAlertResponse,
  importAlertNumberSchema,
  importAlertQuery,
} from '@rejectradar/contracts';
import { ZodValidationPipe } from '../common/zod-pipe';
import { ImportAlertsService } from './import-alerts.service';

/** An Import Alert's text and the summary that may be shown. Any signed-in user may read it; it is reference data and uses no lookup. */
@Controller('import-alerts')
export class ImportAlertsController {
  constructor(private readonly alerts: ImportAlertsService) {}

  @Get(':number')
  get(
    @Param('number', new ZodValidationPipe(importAlertNumberSchema)) number: string,
    @Query(new ZodValidationPipe(importAlertQuery)) query: ImportAlertQuery,
  ): Promise<ImportAlertResponse> {
    return this.alerts.get(number, query.locale);
  }
}
