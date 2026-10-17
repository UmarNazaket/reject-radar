/** FDA import refusal fields, from https://datadashboard.fda.gov/oii/api/api-definitions-refusals.htm (read 2026-10-16). */
export const FDA_REFUSAL_FIELDS = [
  'FEINumber', 'FirmName', 'AddressLine1', 'AddressLine2', 'City', 'State', 'ZipCode', 'CountryCode', 'CountryName',
  'DistrictCode', 'DistrictDescription', 'IndustryCode', 'IndustryCodeDescription', 'ProductCategory', 'ProductCode',
  'ProductCodeDescription', 'RefusalDate', 'ShipmentID', 'FDASampleAnalysis', 'PrivateLabAnalysis', 'RefusalCharges',
  'FirmProfile',
] as const;

export type SourceKind = 'fda-api' | 'json' | 'csv';

export interface SourceSpec {
  kind: SourceKind;
  /** Where to find the documentation or the current download link. */
  docs: string;
  /** Field names phase 2 relies on. Empty until the first real run records them (Step 7). */
  expected: readonly string[];
  /** Fields whose fill rate is measured by default. */
  fillRate: readonly string[];
}

export const SOURCES = {
  fda_refusals: {
    kind: 'fda-api',
    docs: 'https://datadashboard.fda.gov/oii/api/index.htm',
    expected: FDA_REFUSAL_FIELDS,
    fillRate: ['FEINumber', 'FirmName', 'AddressLine1', 'City', 'CountryCode', 'ProductCode', 'RefusalCharges'],
  },
  fda_charge_codes: {
    kind: 'csv',
    docs: 'Refusal Charges Reference (ACT_SECTION_CHARGES.CSV), linked from https://datadashboard.fda.gov/oii/cd/imprefusals.htm',
    expected: [],
    fillRate: [],
  },
  rasff: {
    kind: 'json',
    docs: 'RASFF Window open-data API user guide, linked from https://webgate.ec.europa.eu/imsoc-guide/rasff-window-help/en/',
    expected: [],
    fillRate: [],
  },
  uk_border_notifications: {
    kind: 'csv',
    docs: 'https://www.data.gov.uk/dataset/6d74a70f-e25a-4d54-a2a6-325c7aa57d74/border-notifications-fsa',
    expected: [],
    fillRate: [],
  },
  au_failing_food: {
    kind: 'csv',
    docs: 'https://data.gov.au/data/dataset/imported-food-inspection-scheme-monthly-failing-food-reports',
    expected: [],
    fillRate: [],
  },
  eu_mrl: {
    kind: 'csv',
    docs: 'https://food.ec.europa.eu/plants/pesticides/eu-pesticides-database_en (Data download and APIs)',
    expected: [],
    fillRate: [],
  },
} as const satisfies Record<string, SourceSpec>;

export type SourceName = keyof typeof SOURCES;
export const SOURCE_NAMES = Object.keys(SOURCES) as SourceName[];
