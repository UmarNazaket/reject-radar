import { z } from 'zod';
import { localeSchema } from './accounts';
import type { Destination } from './destinations';

/** Hazard categories as stored in `hazard.category` (the seeds in `@rejectradar/taxonomy` use the same values). */
export const HAZARD_CATEGORIES = [
  'pesticide_residues',
  'fumigants',
  'mycotoxins',
  'pathogens',
  'veterinary_drugs',
  'contaminants',
  'additives',
  'allergens_labelling',
  'filth',
  'registration_process',
  'documents',
  'unclassified',
] as const;
export type HazardCategoryId = (typeof HAZARD_CATEGORIES)[number];

/** `GET /v1/taxonomy?locale=` (P5-D4): the locale defaults to English. */
export const taxonomyQuery = z.object({ locale: localeSchema.default('en') });
export type TaxonomyQuery = z.output<typeof taxonomyQuery>;

export interface TaxonomyResponse {
  commodities: { id: number; slug: string; parentId: number | null; label: string }[];
  hazards: { id: number; slug: string; category: HazardCategoryId; label: string }[];
  hazardCategories: { id: HazardCategoryId; label: string }[];
  destinations: { id: Destination; label: string }[];
  countries: { code: string; label: string }[];
}
