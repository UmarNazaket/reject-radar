import { z } from 'zod';
import { localeSchema } from './accounts';
import type { Locale } from './locales';

/** The longest an English `summary` may be, in words. A translation is not held to it: it can run longer than its source. */
export const SUMMARY_MAX_WORDS = 120;

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * What a summary of an Import Alert holds, in any language. P8.3 validates a translation with this schema, and the
 * endpoint checks stored translations against it before serving.
 */
export const importAlertSummaryContentSchema = z.object({
  summary: z.string().min(1),
  whatTriggersListing: z.string().min(1),
  howFirmsGetRemoved: z.string().min(1),
  testsMentioned: z.array(z.string()),
});
export type ImportAlertSummaryContent = z.output<typeof importAlertSummaryContentSchema>;

/** The same shape for the English summary, whose `summary` has at most 120 words. P8.3 validates the model's English output, and the endpoint stored English rows, with it. */
export const importAlertEnglishSummaryContentSchema = importAlertSummaryContentSchema.extend({
  summary: z
    .string()
    .min(1)
    .refine((text) => wordCount(text) <= SUMMARY_MAX_WORDS, { message: `must be at most ${SUMMARY_MAX_WORDS} words` }),
});

/** `GET /v1/import-alerts/:number?locale=`. */
export const importAlertQuery = z.object({ locale: localeSchema.default('en') });
export type ImportAlertQuery = z.output<typeof importAlertQuery>;

/** An alert number such as `99-08` or `16-131`. */
export const importAlertNumberSchema = z.string().regex(/^\d{2}-\d{2,3}$/, 'must look like 99-08');

/** Only these statuses are ever served (spec §9.10); `machine` is shown with a "Machine translation" label. */
export type ShownSummaryStatus = 'approved' | 'machine';

export interface ImportAlertResponse {
  number: string;
  title: string;
  alertType: string | null;
  publishedOn: string | null;
  reasonText: string | null;
  guidanceText: string | null;
  productText: string | null;
  chargeText: string | null;
  url: string;
  removed: boolean;
  /** The showable summary, or null when none may be shown (P5-D11). `locale` is the language served, which may be English when another was asked for. */
  summary: { locale: Locale; status: ShownSummaryStatus; content: ImportAlertSummaryContent } | null;
}
