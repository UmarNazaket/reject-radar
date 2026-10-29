import { importAlertEnglishSummaryContentSchema, type ImportAlertSummaryContent } from '@rejectradar/contracts';
import { type Database, importAlert, importAlertSummary } from '@rejectradar/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { GenerateJson, ResponseSchema } from './gemini';

/** The shape Gemini is asked for; the contract schema checks it again, with the word limit. */
export const SUMMARY_RESPONSE_SCHEMA: ResponseSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    whatTriggersListing: { type: 'STRING' },
    howFirmsGetRemoved: { type: 'STRING' },
    testsMentioned: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'whatTriggersListing', 'howFirmsGetRemoved', 'testsMentioned'],
  propertyOrdering: ['summary', 'whatTriggersListing', 'howFirmsGetRemoved', 'testsMentioned'],
};

export const DRAFT_SYSTEM = [
  'You summarise US FDA Import Alerts for food exporters. Use only the alert text you are given.',
  'Write plain English that a quality manager who is not a lawyer understands. Do not give advice, opinions or risk judgements, and add no facts that are not in the text.',
  'summary: at most 120 words on what the alert is about and which products and firms it covers.',
  'whatTriggersListing: what leads FDA to list a firm or product, as the text says.',
  'howFirmsGetRemoved: how a firm gets off the alert, as the text says; if the text does not say, write "The alert text does not say."',
  'testsMentioned: the laboratory tests or analyses the text names, as it names them; an empty list when it names none.',
].join('\n');

type AlertText = Pick<typeof importAlert.$inferSelect, 'number' | 'title' | 'reasonText' | 'guidanceText' | 'productText' | 'chargeText'>;

export function draftPrompt(alert: AlertText): string {
  const sections: [string, string | null][] = [
    ['Reason for alert', alert.reasonText],
    ['Guidance', alert.guidanceText],
    ['Product description', alert.productText],
    ['Charge', alert.chargeText],
  ];
  return [`Import Alert ${alert.number}: ${alert.title}`, ...sections.filter(([, text]) => text).map(([heading, text]) => `${heading}:\n${text}`)].join('\n\n');
}

/** Asks twice at most; returns null when neither answer passes the schema. */
export async function generateValid<T>(generate: () => Promise<unknown>, parse: (value: unknown) => { success: true; data: T } | { success: false }): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = parse(await generate());
    if (parsed.success) return parsed.data;
  }
  return null;
}

export interface DraftResult {
  drafted: string[];
  /** Alerts whose answers failed the schema twice; drafted again on the next run. */
  invalid: string[];
  /** The alert whose Gemini call failed, which ends the run; drafted again on the next run. */
  failed: string[];
}

/**
 * Drafts the English summary of each food Import Alert that is listed and has no English summary of its current text
 * (spec §9.10). A draft replaces the alert's previous English row, whatever its status, and waits for a person. A
 * rejected summary of the current text is not drafted again until FDA changes the text.
 */
export async function draftSummaries(
  deps: { db: Database; model: string; generateJson: GenerateJson },
  options: { limit: number; only?: string[] },
): Promise<DraftResult> {
  const alerts = await deps.db
    .select({
      number: importAlert.number,
      title: importAlert.title,
      reasonText: importAlert.reasonText,
      guidanceText: importAlert.guidanceText,
      productText: importAlert.productText,
      chargeText: importAlert.chargeText,
      textSha256: importAlert.textSha256,
    })
    .from(importAlert)
    .leftJoin(
      importAlertSummary,
      and(eq(importAlertSummary.alertNumber, importAlert.number), eq(importAlertSummary.locale, 'en'), eq(importAlertSummary.sourceSha256, importAlert.textSha256)),
    )
    .where(
      and(
        eq(importAlert.isFood, true),
        isNull(importAlert.removedAt),
        isNull(importAlertSummary.alertNumber),
        options.only ? inArray(importAlert.number, options.only) : undefined,
      ),
    )
    .orderBy(asc(importAlert.number))
    .limit(options.limit);

  const result: DraftResult = { drafted: [], invalid: [], failed: [] };
  for (const alert of alerts) {
    let content: ImportAlertSummaryContent | null;
    try {
      content = await generateValid(
        () => deps.generateJson({ system: DRAFT_SYSTEM, prompt: draftPrompt(alert), schema: SUMMARY_RESPONSE_SCHEMA }),
        (value) => importAlertEnglishSummaryContentSchema.safeParse(value),
      );
    } catch (error) {
      console.error(`summaries:draft: ${alert.number}: ${(error as Error).message}`);
      // Gemini is down or refuses the key: the rest wait for the next run rather than fail one by one.
      result.failed.push(alert.number);
      break;
    }
    if (content === null) {
      result.invalid.push(alert.number);
      continue;
    }
    const values = { content, sourceSha256: alert.textSha256, model: deps.model, status: 'draft', reviewedBy: null, reviewedAt: null };
    await deps.db
      .insert(importAlertSummary)
      .values({ alertNumber: alert.number, locale: 'en', ...values })
      .onConflictDoUpdate({ target: [importAlertSummary.alertNumber, importAlertSummary.locale], set: { ...values, updatedAt: sql`now()` } });
    result.drafted.push(alert.number);
  }
  return result;
}
