import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { FirmsModule } from '../firms/firms.module';
import { FirmReportService } from './firm-report.service';
import { PdfRenderer } from './pdf-renderer';
import { ReportsController } from './reports.controller';

@Module({
  imports: [EntitlementsModule, FirmsModule],
  controllers: [ReportsController],
  providers: [PdfRenderer, FirmReportService],
  exports: [PdfRenderer, FirmReportService],
})
export class ReportsModule {}
