import { z } from 'zod';
import { positiveInt } from './notices';

/** `GET /v1/mrl/residues`: pesticide residues whose name starts with, or resembles, the text. */
export const residueSearchQuery = z.object({
  q: z.string().trim().min(2).max(100),
});
export type ResidueSearchQuery = z.output<typeof residueSearchQuery>;

export interface ResidueItem {
  id: string;
  name: string;
}

export interface ResidueSearchResponse {
  /** At most 20, best match first. */
  residues: ResidueItem[];
}

/** A non-negative, finite decimal such as `0.09` (no signs, exponents or spaces) that stays within a sensible bound. */
const labValue = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,6})?$/, 'must be a non-negative decimal number')
  .transform(Number)
  .pipe(z.number().min(0).max(1_000_000));

/** `GET /v1/mrl`: the EU limit of one residue in a commodity, optionally compared with a lab value in mg/kg. */
export const mrlQuery = z.object({
  commodity: positiveInt,
  residue: z.string().trim().min(1).max(20),
  lab: labValue.optional(),
});
export type MrlQuery = z.output<typeof mrlQuery>;

export type MrlComparison = 'above' | 'at_or_below';

export interface MrlLimit {
  productCode: string;
  productName: string;
  /** mg/kg; null when the regulation needs no limit for the product. */
  mrlMgKg: number | null;
  /** True for a limit at the limit of analytical determination (written `0.01*`). */
  isLod: boolean;
  legalRef: string | null;
  /** `YYYY-MM-DD`. */
  applicableFrom: string | null;
  /** The lab value against the limit; null when no lab value was given or the product has no numeric limit. */
  comparison: MrlComparison | null;
}

export interface MrlNotice {
  reference: string;
  /** `YYYY-MM-DD`. */
  notifiedOn: string;
  subject: string;
  originCountries: string[];
  url: string | null;
}

export interface MrlResponse {
  commodityId: number;
  residue: ResidueItem;
  /** The EU product codes of the commodity, or of its nearest ancestor that has any; empty when none map. */
  productCodes: string[];
  limits: MrlLimit[];
  /** The latest RASFF notices of the last three years that name the residue, for the commodity or below. */
  notices: MrlNotice[];
}
