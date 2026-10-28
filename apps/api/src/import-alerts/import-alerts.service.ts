import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  type ImportAlertResponse,
  importAlertSummaryContentSchema,
  type Locale,
  type ShownSummaryStatus,
} from '@rejectradar/contracts';
import { type Database, importAlert, importAlertSummary } from '@rejectradar/db';
import { and, eq, inArray } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';

type Shown = NonNullable<ImportAlertResponse['summary']>;

/** Import Alert text and its summaries (spec §9.10): only a summary that may be shown is ever returned. */
@Injectable()
export class ImportAlertsService {
  private readonly logger = new Logger(ImportAlertsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async get(number: string, locale: Locale): Promise<ImportAlertResponse> {
    const [alert] = await this.db.select().from(importAlert).where(eq(importAlert.number, number)).limit(1);
    if (alert === undefined) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');

    // Only summaries of the text as it stands now; `rejected` and `draft` are never read, so they cannot be served.
    const rows = await this.db
      .select()
      .from(importAlertSummary)
      .where(
        and(
          eq(importAlertSummary.alertNumber, number),
          eq(importAlertSummary.sourceSha256, alert.textSha256),
          inArray(importAlertSummary.status, ['approved', 'machine']),
        ),
      );

    const shown = (row: (typeof rows)[number] | undefined): Shown | null => {
      if (row === undefined) return null;
      const parsed = importAlertSummaryContentSchema.safeParse(row.content);
      if (!parsed.success) {
        // The content is deliberately not logged.
        this.logger.warn(`Stored summary of Import Alert ${number} (${row.locale}) fails the schema and is not served.`);
        return null;
      }
      return { locale: row.locale as Locale, status: row.status as ShownSummaryStatus, content: parsed.data };
    };

    // P5-D11: English must be approved; a translation is shown only behind it.
    const englishRow = rows.find((r) => r.locale === 'en' && r.status === 'approved');
    const english = shown(englishRow);
    let summary: Shown | null = english;
    if (english !== null && locale !== 'en') {
      summary = shown(rows.find((r) => r.locale === locale)) ?? english;
    }

    return {
      number: alert.number,
      title: alert.title,
      alertType: alert.alertType,
      publishedOn: alert.publishedOn,
      reasonText: alert.reasonText,
      guidanceText: alert.guidanceText,
      productText: alert.productText,
      chargeText: alert.chargeText,
      url: alert.url,
      removed: alert.removedAt !== null,
      summary,
    };
  }
}
