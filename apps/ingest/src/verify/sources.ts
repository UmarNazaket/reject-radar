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
    docs: 'https://datadashboard.fda.gov/oii/download/ACT_SECTION_CHARGES.CSV, linked from https://datadashboard.fda.gov/oii/cd/imprefusals.htm',
    expected: ['ASC_ID', 'CHRG_CODE', 'CHRG_STMNT_TEXT', 'SCTN_NAME'],
    fillRate: ['CHRG_CODE', 'CHRG_STMNT_TEXT'],
  },
  rasff: {
    kind: 'json',
    // POST https://webgate.ec.europa.eu/rasff-window/backend/public/notification/search/consolidated/en/ with
    // {"parameters":{"pageNumber":1,"itemsPerPage":100}}; records under "notifications". Hazards are only in
    // GET .../backend/public/notification/view/id/<notifId>/ (checked 2026-10-17).
    docs: 'RASFF Window public backend (https://webgate.ec.europa.eu/rasff-window/screen/search)',
    expected: [
      'notifId', 'ecValidationDate', 'reference', 'notifyingCountry', 'subject', 'productCategory', 'productType',
      'notificationClassification', 'riskDecision', 'published', 'originCountries',
    ],
    fillRate: ['reference', 'subject', 'originCountries', 'productCategory'],
  },
  uk_border_notifications: {
    kind: 'csv',
    docs: 'https://www.data.gov.uk/dataset/6d74a70f-e25a-4d54-a2a6-325c7aa57d74/border-notifications-fsa',
    expected: [
      'DateBNRaised', 'Country', 'Commodity', 'NetWeight', 'ProductCategory', 'ProductName',
      'ControlledByLegislationYOrN', 'TypeOfConsignment', 'HazardCategory', 'TypeOfFailure', 'ReasonForFailure',
    ],
    fillRate: ['Country', 'HazardCategory', 'ProductCategory'],
  },
  au_failing_food: {
    kind: 'csv',
    docs: 'https://data.gov.au/data/dataset/imported-food-inspection-scheme-monthly-failing-food-reports',
    // "County of origin" is the source's own spelling.
    expected: [
      'Date of fail', 'Product description', 'County of origin', 'Producer Name', 'Test applied / reason for fail',
      'Results / Units', 'Reference criteria', 'Food category',
    ],
    fillRate: ['Producer Name', 'County of origin'],
  },
  eu_mrl: {
    // XML, not CSV: eight files, https://ec.europa.eu/food/plant/pesticides/eu-pesticides-database/backend/api/mrl/download/link?filename=Publication<1-8>.xml
    // (<Substances> with <Name>, <Pest_res_id>, <entry_force>, <directive>, then <Product> with <Product_name>,
    // <Product_code>, <MRL>, <ApplicationDate>). Checked with probe-page, not verify-source.
    kind: 'csv',
    docs: 'https://ec.europa.eu/food/plant/pesticides/eu-pesticides-database/start/screen/mrls/download',
    expected: [],
    fillRate: [],
  },
} as const satisfies Record<string, SourceSpec>;

export type SourceName = keyof typeof SOURCES;
export const SOURCE_NAMES = Object.keys(SOURCES) as SourceName[];
