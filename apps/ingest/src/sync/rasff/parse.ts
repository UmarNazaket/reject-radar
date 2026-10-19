import type { NoticeType } from '@rejectradar/contracts';
import { z } from 'zod';

export const RASFF_SEARCH_URL = 'https://webgate.ec.europa.eu/rasff-window/backend/public/notification/search/consolidated/en/';
export const rasffDetailUrl = (notifId: number): string =>
  `https://webgate.ec.europa.eu/rasff-window/backend/public/notification/view/id/${notifId}/`;
export const rasffPublicUrl = (notifId: number): string => `https://webgate.ec.europa.eu/rasff-window/screen/notification/${notifId}`;

export interface RasffListItem {
  notifId: number;
  reference: string;
  /** `YYYY-MM-DD`. */
  notifiedOn: string;
  /** `''` when the list gives none (4 of 33,019 notifications in October 2026). */
  subject: string;
  productCategory: string | null;
  /** `food`, `feed` or `food contact material`. */
  productType: string | null;
  classification: string | null;
  riskDecision: string | null;
  /** ISO code of the notifying country. */
  notifyingCountry: string | null;
  originCountries: string[];
}

export interface RasffHazard {
  name: string;
  category: string | null;
  analyticalResult: string | null;
  unit: string | null;
  maxPermittedLvl: string | null;
}

export interface RasffDetail {
  distributionCountries: string[];
  originCountries: string[];
  hazards: RasffHazard[];
}

const MAX_TEXT = 1000;

/** Text that may arrive as a number; blank becomes null and long values are cut. */
const optionalText = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value): string | null => {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed.slice(0, MAX_TEXT);
  });

const description = z.object({ description: optionalText }).nullish().transform((value) => value?.description ?? null);

const country = z.object({ isoCode: optionalText });

const countries = z
  .array(country)
  .nullish()
  .transform((list): string[] => [...new Set((list ?? []).map((c) => c.isoCode?.toUpperCase()).filter((code): code is string => !!code))]);

const rasffDate = z.string().transform((value, ctx): string => {
  const match = /^(\d{2})-(\d{2})-(\d{4})(?: \d{2}:\d{2}:\d{2})?$/.exec(value.trim());
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : null;
  if (iso === null || Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) {
    ctx.addIssue({ code: 'custom', message: `expected DD-MM-YYYY HH:mm:ss, got "${value}"` });
    return z.NEVER;
  }
  return iso;
});

const listItemSchema = z.object({
  notifId: z.number().int().positive(),
  ecValidationDate: rasffDate,
  reference: z.string().trim().min(1),
  notifyingCountry: country.nullish(),
  subject: z
    .string()
    .nullish()
    .transform((value) => (value ?? '').trim()),
  productCategory: description,
  productType: description,
  notificationClassification: description,
  riskDecision: description,
  originCountries: countries,
});

const searchPageSchema = z.object({
  notifications: z.array(listItemSchema),
  totalPages: z.number().int().nonnegative(),
});

const detailSchema = z.object({
  product: z.object({
    hazards: z.array(
      z.object({
        name: z.string().trim().min(1),
        analyticalResult: optionalText,
        unit: optionalText,
        maxPermittedLvl: optionalText,
        hazardCategory: description,
      }),
    )
    // Notifications of 2019-20 have no hazards list (only a free-text risk.hazardObserved): no hazards.
    .optional(),
  }),
  organizationFlags: z.array(
    z.object({
      organization: z.object({ code: optionalText }),
      notificationFlags: z.array(z.object({ flagType: z.string() })),
    }),
  ),
});

function fail(what: string, error: z.ZodError): never {
  const issues = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new Error(`RASFF ${what} has an unexpected structure (the undocumented backend may have changed): ${issues.slice(0, 10).join('; ')}`);
}

/** Reads one page of the search list; throws, naming the field path, when the structure is not as expected. */
export function parseSearchPage(json: unknown): { items: RasffListItem[]; totalPages: number } {
  const result = searchPageSchema.safeParse(json);
  if (!result.success) fail('search page', result.error);
  return {
    totalPages: result.data.totalPages,
    items: result.data.notifications.map((n) => ({
      notifId: n.notifId,
      reference: n.reference,
      notifiedOn: n.ecValidationDate,
      subject: n.subject,
      productCategory: n.productCategory,
      productType: n.productType,
      classification: n.notificationClassification,
      riskDecision: n.riskDecision,
      notifyingCountry: n.notifyingCountry?.isoCode?.toUpperCase() ?? null,
      originCountries: n.originCountries,
    })),
  };
}

/**
 * Reads the hazards and the origin and distribution countries from a notification's detail.
 * Everything else, above all `additionalInformations` (it names officials), is dropped.
 */
export function parseDetail(json: unknown): RasffDetail {
  const result = detailSchema.safeParse(json);
  if (!result.success) fail('notification detail', result.error);
  const countriesFlagged = (flag: string): string[] => [
    ...new Set(
      result.data.organizationFlags
        .filter((o) => o.notificationFlags.some((f) => f.flagType === flag))
        .map((o) => o.organization.code?.toUpperCase())
        .filter((code): code is string => !!code),
    ),
  ];
  return {
    distributionCountries: countriesFlagged('DISTRIBUTION'),
    originCountries: countriesFlagged('ORIGIN'),
    hazards: (result.data.product.hazards ?? []).map((h) => ({
      name: h.name,
      category: h.hazardCategory,
      analyticalResult: h.analyticalResult,
      unit: h.unit,
      maxPermittedLvl: h.maxPermittedLvl,
    })),
  };
}

export function rasffNoticeType(classification: string | null): NoticeType {
  const value = classification?.trim().toLowerCase() ?? '';
  if (value.startsWith('alert notification')) return 'rasff_alert';
  if (value.startsWith('border rejection notification')) return 'rasff_border_rejection';
  if (value.startsWith('information notification')) return 'rasff_information';
  return 'rasff_other';
}
