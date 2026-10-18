export type HazardCategory =
  | 'pesticide_residues'
  | 'fumigants'
  | 'mycotoxins'
  | 'pathogens'
  | 'veterinary_drugs'
  | 'contaminants'
  | 'additives'
  | 'allergens_labelling'
  | 'filth'
  | 'registration_process'
  | 'documents'
  | 'unclassified';

export interface HazardSeed {
  id: number;
  slug: string;
  name: string;
  category: HazardCategory;
}

/** Fallback hazard for anything no rule recognises. */
export const UNCLASSIFIED_ID = 1200;

export const HAZARDS: readonly HazardSeed[] = [
  { id: 100, slug: 'pesticide-residues', name: 'Pesticide residues', category: 'pesticide_residues' },
  { id: 200, slug: 'ethylene-oxide', name: 'Ethylene oxide and fumigants', category: 'fumigants' },
  { id: 300, slug: 'aflatoxins', name: 'Aflatoxins', category: 'mycotoxins' },
  { id: 301, slug: 'ochratoxin-a', name: 'Ochratoxin A', category: 'mycotoxins' },
  { id: 302, slug: 'other-mycotoxins', name: 'Other mycotoxins', category: 'mycotoxins' },
  { id: 400, slug: 'salmonella', name: 'Salmonella', category: 'pathogens' },
  { id: 401, slug: 'listeria', name: 'Listeria', category: 'pathogens' },
  { id: 402, slug: 'stec', name: 'STEC (E. coli)', category: 'pathogens' },
  { id: 403, slug: 'other-pathogens', name: 'Other micro-organisms', category: 'pathogens' },
  { id: 500, slug: 'veterinary-drugs', name: 'Veterinary drug residues', category: 'veterinary_drugs' },
  { id: 600, slug: 'heavy-metals', name: 'Heavy metals', category: 'contaminants' },
  { id: 601, slug: 'other-contaminants', name: 'Other contaminants', category: 'contaminants' },
  { id: 700, slug: 'unauthorised-colours', name: 'Unauthorised colours (e.g. Sudan dyes)', category: 'additives' },
  { id: 701, slug: 'unauthorised-additives', name: 'Unauthorised or excess additives', category: 'additives' },
  { id: 800, slug: 'undeclared-allergens', name: 'Undeclared allergens', category: 'allergens_labelling' },
  { id: 801, slug: 'labelling', name: 'Labelling and composition', category: 'allergens_labelling' },
  { id: 900, slug: 'filth-decomposition', name: 'Filth and decomposition', category: 'filth' },
  { id: 901, slug: 'foreign-bodies', name: 'Foreign bodies', category: 'filth' },
  { id: 1000, slug: 'registration-process', name: 'Registration and process filing', category: 'registration_process' },
  { id: 1100, slug: 'documents', name: 'Documents and certificates', category: 'documents' },
  { id: 1200, slug: 'unclassified', name: 'Unclassified', category: 'unclassified' },
];
