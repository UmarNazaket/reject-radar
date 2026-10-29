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

/** `draft` and `approved` are English (a person decides); `machine` is a translation of approved English; `rejected` is never drafted again for the same text. */
export const SUMMARY_STATUSES = ['draft', 'approved', 'rejected', 'machine'] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

/** Only these statuses are ever served (spec §9.10); `machine` is shown with a "Machine translation" label. */
export type ShownSummaryStatus = 'approved' | 'machine';

/** `GET /v1/admin/import-alert-summaries?status=`: the English summaries waiting for, or past, review. */
export const summaryReviewQuery = z.object({ status: z.enum(['draft', 'approved', 'rejected']).default('draft') });
export type SummaryReviewQuery = z.output<typeof summaryReviewQuery>;

/** `PATCH /v1/admin/import-alert-summaries/:number`: approve the draft as it is or with corrected content, or reject it. */
export const reviewSummaryRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), content: importAlertEnglishSummaryContentSchema.optional() }),
  z.object({ action: z.literal('reject') }),
]);
export type ReviewSummaryRequest = z.output<typeof reviewSummaryRequest>;

/** An English summary beside the alert text it summarises, for review. */
export interface SummaryReviewItem {
  number: string;
  title: string;
  reasonText: string | null;
  guidanceText: string | null;
  productText: string | null;
  chargeText: string | null;
  url: string;
  status: SummaryStatus;
  content: ImportAlertSummaryContent;
  model: string;
  /** False when FDA changed the alert text after the summary was made; such a summary cannot be approved. */
  current: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  updatedAt: string;
}

export interface SummaryReviewResponse {
  items: SummaryReviewItem[];
}

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
