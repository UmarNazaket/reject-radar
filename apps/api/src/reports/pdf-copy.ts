/**
 * The words of the PDF reports (spec §9.9, D11): English in every UI language, so they live here and not in the message
 * catalogs. The words "clean" and "safe" never appear (spec §8.3); charge text quoted from FDA is the agency's own.
 */
export const PDF_COPY = {
  product: 'RejectRadar',
  firmReport: 'Firm report',
  preparedFor: 'Prepared for',
  generatedOn: 'Generated',
  utc: 'UTC',

  // Firm header.
  alsoPublishedAs: 'Also published as',
  fei: 'FEI',
  address: 'Address',
  noAddress: 'No address published',

  // Sections.
  facts: 'Facts',
  summary: 'Three-year summary',
  hazards: 'Most frequent hazards',
  refusals: 'Latest FDA refusals',
  listings: 'Import Alert listings',
  auFailures: 'Australian failed tests',
  dataDates: 'Data as of',
  sourcesTitle: 'Sources',

  // Facts.
  onRedList: 'On the FDA Import Alert red list',
  since: 'since',
  noRedList: 'Not on an FDA Import Alert red list in the data on file',
  refusals12m: 'FDA refusals, 12 mo',
  refusals3y: 'FDA refusals, 3 yr',
  auFailed3y: 'Australian failed tests, 3 yr',
  holdingOrder: 'Australian holding order: matched',

  // Three-year summary table.
  recordColumn: 'Record',
  last12: 'Last 12 mo',
  months12to24: '12 to 24 mo',
  months24to36: '24 to 36 mo',
  rowRefusals: 'FDA refusals',
  rowListings: 'Import Alert listings',
  rowAuFailures: 'Australian failed tests',
  noHazards: 'None recorded',
  hazardLabels: {
    pesticide_residues: 'Pesticide residues',
    fumigants: 'Fumigants',
    mycotoxins: 'Mycotoxins',
    pathogens: 'Pathogens',
    veterinary_drugs: 'Veterinary drugs',
    contaminants: 'Contaminants',
    additives: 'Additives',
    allergens_labelling: 'Allergens and labelling',
    filth: 'Filth',
    registration_process: 'Registration and process',
    documents: 'Documents',
    unclassified: 'Unclassified',
  } as Readonly<Record<string, string>>,

  // Record tables.
  date: 'Date',
  productColumn: 'Product',
  charges: 'Charge, in FDA’s words',
  sampleBy: 'Sample by',
  alert: 'Alert',
  title: 'Title',
  list: 'List',
  listed: 'Listed',
  removed: 'Removed',
  test: 'Test',
  result: 'Result',
  holdingOrderColumn: 'Holding order',
  yes: 'yes',
  no: 'no',
  more: (n: number) => `+${n} more`,
  chargeCode: (code: string) => `Charge code ${code}`,
  fdaLab: 'FDA laboratory',
  privateLab: 'Private laboratory',
  bothLabs: 'FDA and private laboratory',
  noSample: 'Not reported',
  redList: 'Red',
  greenList: 'Green',
  /** Said once on a report that quotes FDA's charge text. */
  agencyWording: 'Text in quotation marks is the agency’s own wording, not RejectRadar’s.',
  emptyRecords: 'No records on file.',
  notDated: 'Not dated',

  // Data dates and sources.
  sourceNames: {
    fda_refusals: 'FDA import refusals',
    import_alerts: 'FDA Import Alerts',
    au_ifis: 'Australia failing food reports',
  },
  notSynced: 'not yet available',
  dataToMonth: (month: string) => `data to ${month}`,
  sources:
    'Sources: FDA Data Dashboard (import refusals); FDA Import Alerts, accessdata.fda.gov; Department of Agriculture, Fisheries and Forestry, Imported Food Inspection Scheme failing food reports, CC BY 4.0.',
  noBorderFirms: 'EU and UK border notices do not name exporters, so they are not part of a firm report.',

  // The topic report.
  topicReport: 'Topic report',
  commodityLabel: 'Commodity',
  allCommodities: 'All commodities',
  commodityNumber: (id: number) => `Commodity ${id}`,
  destinationsLabel: 'Destinations',
  allDestinations: 'All destinations',
  monthlyCounts: 'Notices by month',
  month: 'Month',
  total: 'Total',
  totals12m: 'Last 12 months',
  noticesLabel: 'Notices',
  topHazards: 'Most frequent hazards, last 12 months',
  hazard: 'Hazard',
  hazardNumber: (id: number) => `Hazard ${id}`,
  latestNotices: 'Latest notices',
  noticeTo: 'To',
  noticeProduct: 'Product',
  noticeFirm: 'Firm named',
  noticeHazards: 'Hazards',
  historyFrom: (date: string) => `Your plan shows notices from ${date}.`,
  topicNote:
    'Counts are agency notices that match the topic, by the month each notice is dated. EU and UK notices do not name exporters, and a count says nothing about any one exporter.',
  topicSourceNames: {
    fda_refusals: 'FDA import refusals',
    rasff: 'EU RASFF notifications',
    uk_bn: 'UK border notifications',
    au_ifis: 'Australia failing food reports',
  } as Readonly<Record<string, string>>,
  topicSources: {
    US: 'US: FDA Data Dashboard (import refusals).',
    EU: 'EU: European Commission, RASFF Window public notifications.',
    UK: 'UK: Food Standards Agency border notifications, data.gov.uk.',
    AU: 'AU: Department of Agriculture, Fisheries and Forestry, Imported Food Inspection Scheme failing food reports, CC BY 4.0.',
  } as Readonly<Record<'US' | 'EU' | 'UK' | 'AU', string>>,

  disclaimer:
    'RejectRadar reports what agencies published. It is not legal, regulatory or laboratory advice. A refusal or listing is an agency action based on how a shipment appeared, not a court finding. RejectRadar is not affiliated with the FDA or DAFF. Check each record on the agency’s site before acting on it.',
} as const;
