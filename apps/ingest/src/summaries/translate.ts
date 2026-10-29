import { type ImportAlertSummaryContent, importAlertSummaryContentSchema, LOCALES } from '@rejectradar/contracts';
import { type Database, importAlertSummary } from '@rejectradar/db';
import { sql } from 'drizzle-orm';
import { generateValid, SUMMARY_RESPONSE_SCHEMA } from './draft';
import type { GenerateJson } from './gemini';

const LANGUAGES: Readonly<Record<string, string>> = { ur: 'Urdu', hi: 'Hindi', bn: 'Bengali' };
const TARGETS = LOCALES.filter((locale) => locale !== 'en');

export const translateSystem = (language: string) =>
  [
    `Translate this summary of a US FDA Import Alert from English into ${language}, for food exporters.`,
    'Translate every field, and each item of testsMentioned, keeping the same meaning and adding nothing.',
    'Keep numbers, product codes, alert numbers and the names "FDA" and "Import Alert" as they are.',
  ].join('\n');

export interface TranslateResult {
  translated: string[];
  invalid: string[];
  failed: string[];
}

/**
 * Machine-translates each approved English summary of an alert's current text into every other app language that has
 * no translation of that text yet (spec §9.10). Translations are stored as `machine`: shown with a label, and only while
 * the English stays approved. `limit` counts translations, not alerts.
 */
export async function translateSummaries(deps: { db: Database; model: string; generateJson: GenerateJson }, options: { limit: number }): Promise<TranslateResult> {
  const targets = sql.join(TARGETS.map((locale) => sql`${locale}`), sql`, `);
  const pending = await deps.db.execute<{ alert_number: string; locale: string; content: ImportAlertSummaryContent; source_sha256: string }>(sql`
    select e.alert_number, l.locale, e.content, e.source_sha256
    from import_alert_summary e
    join import_alert a on a.number = e.alert_number and a.text_sha256 = e.source_sha256
    cross join unnest(array[${targets}]::text[]) as l(locale)
    left join import_alert_summary t on t.alert_number = e.alert_number and t.locale = l.locale and t.source_sha256 = e.source_sha256
    where e.locale = 'en' and e.status = 'approved' and t.alert_number is null
    order by e.alert_number, l.locale
    limit ${options.limit}`);

  const result: TranslateResult = { translated: [], invalid: [], failed: [] };
  for (const row of pending.rows) {
    const label = `${row.alert_number} (${row.locale})`;
    let content: ImportAlertSummaryContent | null;
    try {
      content = await generateValid(
        () => deps.generateJson({ system: translateSystem(LANGUAGES[row.locale]), prompt: JSON.stringify(row.content), schema: SUMMARY_RESPONSE_SCHEMA }),
        (value) => importAlertSummaryContentSchema.safeParse(value),
      );
    } catch (error) {
      console.error(`summaries:translate: ${label}: ${(error as Error).message}`);
      result.failed.push(label);
      continue;
    }
    if (content === null) {
      result.invalid.push(label);
      continue;
    }
    const values = { content, sourceSha256: row.source_sha256, model: deps.model, status: 'machine', reviewedBy: null, reviewedAt: null };
    await deps.db
      .insert(importAlertSummary)
      .values({ alertNumber: row.alert_number, locale: row.locale, ...values })
      .onConflictDoUpdate({ target: [importAlertSummary.alertNumber, importAlertSummary.locale], set: { ...values, updatedAt: sql`now()` } });
    result.translated.push(label);
  }
  return result;
}
