import { Module } from '@nestjs/common';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { FirmsModule } from '../firms/firms.module';
import { NoticesModule } from '../notices/notices.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { FirmReportService } from './firm-report.service';
import { PdfRenderer } from './pdf-renderer';
import { ReportsController } from './reports.controller';
import { TopicReportService } from './topic-report.service';

@Module({
  imports: [EntitlementsModule, FirmsModule, NoticesModule, TaxonomyModule],
  controllers: [ReportsController],
  providers: [PdfRenderer, FirmReportService, TopicReportService],
  exports: [PdfRenderer, FirmReportService, TopicReportService],
})
export class ReportsModule {}
