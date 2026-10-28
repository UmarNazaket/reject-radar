import { z } from 'zod';

/**
 * `GET /v1/firms/search` (spec §8.3, P5-D8): a firm name, or an FDA establishment number, narrowed by country and city.
 * Either `name` or `fei` is required; an FEI goes straight to its firm.
 */
export const firmSearchQuery = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    /** ISO 3166-1 alpha-2, uppercase. A filter, not a score. */
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    /** Raises the score of a firm in this city (compared after the same normalisation the firm's city went through). */
    city: z.string().max(100).optional(),
    fei: z.string().regex(/^\d{1,15}$/, 'must be digits only').optional(),
  })
  .refine((query) => query.name !== undefined || query.fei !== undefined, { message: 'name or fei is required', path: ['name'] });
export type FirmSearchQuery = z.output<typeof firmSearchQuery>;

/** How well a result matches the query, as spec §8.3 labels it. Results below `other` are not returned. */
export const FIRM_SEARCH_LABELS = ['strong', 'possible', 'other'] as const;
export type FirmSearchLabel = (typeof FIRM_SEARCH_LABELS)[number];

/** One firm found. Facts (flags, metrics, counts) are on the profile, which uses a lookup; search shows none. */
export interface FirmSearchResult {
  id: number;
  displayName: string;
  label: FirmSearchLabel;
  /** 0 to 1, four decimals. */
  score: number;
  countryCode: string | null;
  city: string | null;
  region: string | null;
  commodityIds: number[];
  /** `YYYY-MM-DD`. */
  lastNoticeOn: string | null;
}

export interface FirmSearchResponse {
  results: FirmSearchResult[];
}
