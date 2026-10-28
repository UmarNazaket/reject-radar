import { z } from 'zod';
import { DISPUTE_KINDS } from './product';
import type { SourceFreshness } from './notices';
import { FIRM_RECORD_SOURCES, type FirmFlags, type FirmMetrics } from './firms';

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

/** A charge FDA refused an entry on; `name` and `description` come from FDA's charge-code list and are null for a code it does not list. */
export interface FirmRefusalCharge {
  code: string;
  name: string | null;
  description: string | null;
}

/** An FDA import refusal of the firm. Dates are `YYYY-MM-DD`. */
export interface FirmRefusal {
  id: number;
  refusalDate: string;
  productCode: string | null;
  productDesc: string | null;
  charges: FirmRefusalCharge[];
  fdaSampleAnalysis: boolean | null;
  privateLabAnalysis: boolean | null;
  url: string | null;
}

export interface FirmListingProduct {
  productCode: string | null;
  productName: string | null;
  description: string | null;
  listedOn: string | null;
  notes: string | null;
  removedOn: string | null;
}

/** A listing of the firm on an Import Alert; `removedOn` is set once FDA has taken the firm off. */
export interface FirmListing {
  id: number;
  alertNumber: string;
  alertTitle: string;
  list: 'red' | 'green';
  listedOn: string | null;
  removedOn: string | null;
  url: string;
  products: FirmListingProduct[];
}

/** A failed test of a product the firm produced, from the Australian Imported Food Inspection Scheme. */
export interface FirmAuFailure {
  id: number;
  failedOn: string | null;
  /** `YYYY-MM`. */
  reportMonth: string;
  productDesc: string;
  testApplied: string | null;
  reason: string | null;
  resultText: string | null;
  holdingOrderMatch: boolean | null;
  url: string | null;
}

export interface FirmAddress {
  line: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
}

/**
 * `GET /v1/firms/:id` (spec §9.4, P5-D9, P5-D10). `id` is the firm's own and differs from the id asked for when that
 * firm was merged into another. Opening a profile uses one lookup unless the account opened the firm this month.
 * Records are all of them, newest first; the web app puts those older than 3 years under "History".
 */
export interface FirmProfileResponse {
  id: number;
  displayName: string;
  altNames: string[];
  /** FDA establishment numbers, as text. */
  feis: string[];
  /** The published address of the firm's latest record that carries one. */
  address: FirmAddress;
  commodityIds: number[];
  /** `YYYY-MM-DD`. */
  firstSeen: string | null;
  lastNoticeOn: string | null;
  facts: FirmFlags;
  metrics: FirmMetrics;
  refusals: FirmRefusal[];
  listings: FirmListing[];
  auFailures: FirmAuFailure[];
  freshness: SourceFreshness[];
  lookup: { charged: boolean; used: number; limit: number };
}

/**
 * `POST /v1/firms/:id/disputes` (P5-D17): the account says a firm's facts or a record linked to it are wrong. A record
 * is named by its source and key, both or neither.
 */
export const createDisputeRequest = z
  .object({
    kind: z.enum(DISPUTE_KINDS),
    message: z.string().trim().min(10).max(2000),
    source: z.enum(FIRM_RECORD_SOURCES).optional(),
    sourceKey: z.string().min(1).max(200).optional(),
  })
  .refine((body) => (body.source === undefined) === (body.sourceKey === undefined), {
    message: 'source and sourceKey go together',
    path: ['sourceKey'],
  });
export type CreateDisputeRequest = z.output<typeof createDisputeRequest>;

export interface DisputeResponse {
  id: string;
}
