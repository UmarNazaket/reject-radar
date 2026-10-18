import {
  DESTINATIONS,
  EVENT_KINDS,
  LISTS,
  NOTICE_SOURCES,
  NOTICE_TYPES,
  RULE_MATCH_TYPES,
  RULE_SOURCES,
  SEVERITIES,
  SYNC_SOURCES,
  SYNC_STATUSES,
} from '@rejectradar/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const emptyTextArray = sql`'{}'::text[]`;
const emptyIntArray = sql`'{}'::int[]`;
const emptyObject = sql`'{}'::jsonb`;

/** `column in ('a', 'b')` built from a contracts union, so the database enforces the same values as the code. */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);

// ── Taxonomy (fixed IDs, seeded in phase 2) ─────────────────────────────────

export const commodity = pgTable(
  'commodity',
  {
    id: integer('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    parentId: integer('parent_id').references((): AnyPgColumn => commodity.id),
    ancestorIds: integer('ancestor_ids').array().notNull().default(emptyIntArray),
    hsHeadings: text('hs_headings').array().notNull().default(emptyTextArray),
    euMrlCodes: text('eu_mrl_codes').array().notNull().default(emptyTextArray),
  },
  (t) => [uniqueIndex('commodity_slug_uq').on(t.slug)],
);

export const commodityRule = pgTable(
  'commodity_rule',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    field: text('field').notNull(),
    matchType: text('match_type').notNull(),
    pattern: text('pattern').notNull(),
    commodityId: integer('commodity_id').notNull().references(() => commodity.id),
    priority: smallint('priority').notNull().default(100),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('commodity_rule_source_idx').on(t.source, t.field),
    check('commodity_rule_source_ck', oneOf('source', RULE_SOURCES)),
    check('commodity_rule_match_type_ck', oneOf('match_type', RULE_MATCH_TYPES)),
  ],
);

export const hazard = pgTable(
  'hazard',
  {
    id: integer('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
  },
  (t) => [uniqueIndex('hazard_slug_uq').on(t.slug)],
);

export const hazardRule = pgTable(
  'hazard_rule',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    field: text('field').notNull(),
    matchType: text('match_type').notNull(),
    pattern: text('pattern').notNull(),
    hazardId: integer('hazard_id').notNull().references(() => hazard.id),
    priority: smallint('priority').notNull().default(100),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('hazard_rule_source_idx').on(t.source, t.field),
    check('hazard_rule_source_ck', oneOf('source', RULE_SOURCES)),
    check('hazard_rule_match_type_ck', oneOf('match_type', RULE_MATCH_TYPES)),
  ],
);

// ── Firms ───────────────────────────────────────────────────────────────────

export const firm = pgTable(
  'firm',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    displayName: text('display_name').notNull(),
    nameNorm: text('name_norm').notNull(),
    altNames: text('alt_names').array().notNull().default(emptyTextArray),
    countryCode: text('country_code'),
    region: text('region'),
    city: text('city'),
    postalCode: text('postal_code'),
    addressNorm: text('address_norm'),
    commodityIds: integer('commodity_ids').array().notNull().default(emptyIntArray),
    firstSeen: date('first_seen'),
    lastNoticeOn: date('last_notice_on'),
    flags: jsonb('flags').notNull().default(emptyObject),
    metrics: jsonb('metrics').notNull().default(emptyObject),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('firm_name_norm_trgm_idx').using('gin', t.nameNorm.op('gin_trgm_ops')),
    index('firm_country_idx').on(t.countryCode),
  ],
);

export const firmAlias = pgTable('firm_alias', {
  oldId: bigint('old_id', { mode: 'number' }).primaryKey(),
  newId: bigint('new_id', { mode: 'number' }).notNull().references(() => firm.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const firmFei = pgTable(
  'firm_fei',
  {
    fei: bigint('fei', { mode: 'number' }).primaryKey(),
    firmId: bigint('firm_id', { mode: 'number' }).notNull().references(() => firm.id),
    firstSeen: date('first_seen'),
  },
  (t) => [index('firm_fei_firm_idx').on(t.firmId)],
);

// ── FDA ─────────────────────────────────────────────────────────────────────

export const fdaChargeCode = pgTable('fda_charge_code', {
  code: text('code').primaryKey(),
  name: text('name'),
  section: text('section'),
  description: text('description'),
  hazardId: integer('hazard_id').references(() => hazard.id),
});

export const fdaRefusal = pgTable(
  'fda_refusal',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceKey: text('source_key').notNull(),
    fei: bigint('fei', { mode: 'number' }),
    firmName: text('firm_name').notNull(),
    nameNorm: text('name_norm').notNull(),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    countryCode: text('country_code'),
    divisionCode: text('division_code'),
    industryCode: text('industry_code'),
    productCode: text('product_code'),
    productDesc: text('product_desc'),
    productCategory: text('product_category'),
    refusalDate: date('refusal_date').notNull(),
    chargeCodes: text('charge_codes').array().notNull().default(emptyTextArray),
    fdaSampleAnalysis: boolean('fda_sample_analysis'),
    privateLabAnalysis: boolean('private_lab_analysis'),
    commodityId: integer('commodity_id').references(() => commodity.id),
    hazardIds: integer('hazard_ids').array().notNull().default(emptyIntArray),
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firm.id),
    linkScore: numeric('link_score', { precision: 5, scale: 4 }),
  },
  (t) => [
    uniqueIndex('fda_refusal_source_key_uq').on(t.sourceKey),
    index('fda_refusal_name_trgm_idx').using('gin', t.nameNorm.op('gin_trgm_ops')),
    index('fda_refusal_firm_idx').on(t.firmId),
    index('fda_refusal_fei_idx').on(t.fei),
    index('fda_refusal_date_idx').on(t.refusalDate),
  ],
);

export const importAlert = pgTable('import_alert', {
  number: text('number').primaryKey(),
  title: text('title').notNull(),
  alertType: text('alert_type'),
  publishedOn: date('published_on'),
  isFood: boolean('is_food').notNull().default(false),
  reasonText: text('reason_text'),
  guidanceText: text('guidance_text'),
  productText: text('product_text'),
  chargeText: text('charge_text'),
  textSha256: text('text_sha256').notNull(),
  url: text('url').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  removedAt: timestamp('removed_at', { withTimezone: true }),
});

export const importAlertListing = pgTable(
  'import_alert_listing',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    listingKey: text('listing_key').notNull(),
    alertNumber: text('alert_number')
      .notNull()
      .references(() => importAlert.number, { onDelete: 'cascade' }),
    list: text('list').notNull(),
    firmName: text('firm_name').notNull(),
    nameNorm: text('name_norm').notNull(),
    addressRaw: text('address_raw'),
    city: text('city'),
    region: text('region'),
    countryCode: text('country_code'),
    /** The country heading as the page writes it; with the raw firm name it identifies a listing for re-keying. */
    countryName: text('country_name'),
    listedOn: date('listed_on'),
    firstSeenOn: date('first_seen_on').notNull(),
    lastSeenOn: date('last_seen_on').notNull(),
    missedRuns: smallint('missed_runs').notNull().default(0),
    removedOn: date('removed_on'),
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firm.id),
    linkScore: numeric('link_score', { precision: 5, scale: 4 }),
  },
  (t) => [
    uniqueIndex('import_alert_listing_key_uq').on(t.listingKey),
    index('import_alert_listing_name_trgm_idx').using('gin', t.nameNorm.op('gin_trgm_ops')),
    index('import_alert_listing_firm_idx').on(t.firmId),
    index('import_alert_listing_alert_idx').on(t.alertNumber),
    check('import_alert_listing_list_ck', oneOf('list', LISTS)),
  ],
);

export const importAlertListingProduct = pgTable(
  'import_alert_listing_product',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    listingId: bigint('listing_id', { mode: 'number' })
      .notNull()
      .references(() => importAlertListing.id, { onDelete: 'cascade' }),
    productCode: text('product_code'),
    productName: text('product_name'),
    description: text('description'),
    listedOn: date('listed_on'),
    notes: text('notes'),
    /** The problems the page lists for the product, in full (`notes` is cut at 1,000 characters); the taxonomy classifies on these. */
    problems: text('problems').array().notNull().default(emptyTextArray),
    /** 0-based place of the product among its listing's products on the page at the last sync; null until a sync has stored it. */
    position: smallint('position'),
    /** Set when the code is missing from the page; cleared when it returns. The row is kept so a return is not a new product. */
    removedOn: date('removed_on'),
  },
  (t) => [index('import_alert_listing_product_listing_idx').on(t.listingId)],
);

export const importAlertSummary = pgTable(
  'import_alert_summary',
  {
    alertNumber: text('alert_number')
      .notNull()
      .references(() => importAlert.number, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    content: jsonb('content').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull().default('draft'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.alertNumber, t.locale] })],
);

// ── Other border sources ────────────────────────────────────────────────────

export const auFailingFood = pgTable(
  'au_failing_food',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceKey: text('source_key').notNull(),
    reportMonth: date('report_month').notNull(),
    failedOn: date('failed_on'),
    productDesc: text('product_desc').notNull(),
    countryCode: text('country_code'),
    producerName: text('producer_name'),
    nameNorm: text('name_norm').notNull().default(''),
    testApplied: text('test_applied'),
    reason: text('reason'),
    resultText: text('result_text'),
    holdingOrderMatch: boolean('holding_order_match'),
    scheme: text('scheme'),
    commodityId: integer('commodity_id').references(() => commodity.id),
    hazardIds: integer('hazard_ids').array().notNull().default(emptyIntArray),
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firm.id),
    linkScore: numeric('link_score', { precision: 5, scale: 4 }),
  },
  (t) => [
    uniqueIndex('au_failing_food_source_key_uq').on(t.sourceKey),
    index('au_failing_food_name_trgm_idx').using('gin', t.nameNorm.op('gin_trgm_ops')),
    index('au_failing_food_firm_idx').on(t.firmId),
    index('au_failing_food_failed_on_idx').on(t.failedOn),
  ],
);

export const rasffNotification = pgTable(
  'rasff_notification',
  {
    reference: text('reference').primaryKey(),
    notifiedOn: date('notified_on').notNull(),
    classification: text('classification'),
    riskDecision: text('risk_decision'),
    notifyingCountry: text('notifying_country'),
    originCountries: text('origin_countries').array().notNull().default(emptyTextArray),
    distributionCountries: text('distribution_countries').array().notNull().default(emptyTextArray),
    productCategory: text('product_category'),
    subject: text('subject').notNull(),
    hazards: jsonb('hazards').notNull().default(sql`'[]'::jsonb`),
    commodityId: integer('commodity_id').references(() => commodity.id),
    hazardIds: integer('hazard_ids').array().notNull().default(emptyIntArray),
    url: text('url'),
    /** When the detail was last fetched successfully (or given up on); null means it still has to be fetched. */
    detailsFetchedAt: timestamp('details_fetched_at', { withTimezone: true }),
  },
  (t) => [index('rasff_notification_notified_on_idx').on(t.notifiedOn)],
);

export const ukBorderNotification = pgTable(
  'uk_border_notification',
  {
    sourceKey: text('source_key').primaryKey(),
    notifiedOn: date('notified_on').notNull(),
    originCountry: text('origin_country'),
    commodity: text('commodity'),
    productCategory: text('product_category'),
    productName: text('product_name'),
    hazardCategory: text('hazard_category'),
    failureType: text('failure_type'),
    reason: text('reason'),
    consignmentType: text('consignment_type'),
    legislationControlled: text('legislation_controlled'),
    commodityId: integer('commodity_id').references(() => commodity.id),
    hazardIds: integer('hazard_ids').array().notNull().default(emptyIntArray),
  },
  (t) => [index('uk_border_notification_notified_on_idx').on(t.notifiedOn)],
);

// ── EU MRLs ─────────────────────────────────────────────────────────────────

export const euMrlProduct = pgTable('eu_mrl_product', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  parentCode: text('parent_code'),
});

export const euPesticideResidue = pgTable(
  'eu_pesticide_residue',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nameNorm: text('name_norm').notNull(),
  },
  (t) => [index('eu_pesticide_residue_name_trgm_idx').using('gin', t.nameNorm.op('gin_trgm_ops'))],
);

export const euMrl = pgTable(
  'eu_mrl',
  {
    productCode: text('product_code')
      .notNull()
      .references(() => euMrlProduct.code, { onDelete: 'cascade' }),
    residueId: text('residue_id')
      .notNull()
      .references(() => euPesticideResidue.id, { onDelete: 'cascade' }),
    mrlMgKg: numeric('mrl_mg_kg', { precision: 12, scale: 4 }),
    isLod: boolean('is_lod').notNull().default(false),
    legalRef: text('legal_ref'),
    applicableFrom: date('applicable_from'),
  },
  (t) => [primaryKey({ columns: [t.productCode, t.residueId] }), index('eu_mrl_residue_idx').on(t.residueId)],
);

// ── Unified notices, events and pipeline state ─────────────────────────────

export const notice = pgTable(
  'notice',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    destination: text('destination').notNull(),
    noticeType: text('notice_type').notNull(),
    noticeOn: date('notice_on').notNull(),
    originCountry: text('origin_country'),
    commodityId: integer('commodity_id').references(() => commodity.id),
    hazardIds: integer('hazard_ids').array().notNull().default(emptyIntArray),
    productText: text('product_text'),
    firmName: text('firm_name'),
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firm.id),
    title: text('title'),
    url: text('url'),
  },
  (t) => [
    uniqueIndex('notice_source_key_uq').on(t.source, t.sourceKey),
    index('notice_destination_date_idx').on(t.destination, t.noticeOn),
    index('notice_origin_commodity_date_idx').on(t.originCountry, t.commodityId, t.noticeOn),
    index('notice_firm_idx').on(t.firmId),
    index('notice_hazard_ids_idx').using('gin', t.hazardIds),
    index('notice_product_trgm_idx').using('gin', t.productText.op('gin_trgm_ops')),
    index('notice_url_idx').on(t.url),
    check('notice_source_ck', oneOf('source', NOTICE_SOURCES)),
    check('notice_destination_ck', oneOf('destination', DESTINATIONS)),
    check('notice_notice_type_ck', oneOf('notice_type', NOTICE_TYPES)),
  ],
);

export const changeEvent = pgTable(
  'change_event',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    occurredOn: date('occurred_on').notNull(),
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firm.id),
    requiresFirm: boolean('requires_firm').notNull().default(false),
    originCountry: text('origin_country'),
    commodityId: integer('commodity_id').references(() => commodity.id),
    destination: text('destination'),
    hazardIds: integer('hazard_ids').array().notNull().default(emptyIntArray),
    noticeId: bigint('notice_id', { mode: 'number' }).references(() => notice.id),
    payload: jsonb('payload').notNull().default(emptyObject),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('change_event_firm_idx').on(t.firmId),
    index('change_event_source_key_idx').on(t.source, t.sourceKey),
    index('change_event_notice_idx').on(t.noticeId),
    check('change_event_source_ck', oneOf('source', NOTICE_SOURCES)),
    check('change_event_kind_ck', oneOf('kind', EVENT_KINDS)),
    check('change_event_severity_ck', oneOf('severity', SEVERITIES)),
    check('change_event_destination_ck', oneOf('destination', DESTINATIONS)),
  ],
);

export const matchReview = pgTable(
  'match_review',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    sourceKey: text('source_key').notNull(),
    firmId: bigint('firm_id', { mode: 'number' }).notNull().references(() => firm.id),
    candidateFirmId: bigint('candidate_firm_id', { mode: 'number' }).notNull().references(() => firm.id),
    score: numeric('score', { precision: 5, scale: 4 }).notNull(),
    reason: text('reason').notNull().default('score_band'),
    evidence: jsonb('evidence').notNull().default(emptyObject),
    status: text('status').notNull().default('open'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('match_review_status_idx').on(t.status)],
);

export const sourceSyncRun = pgTable(
  'source_sync_run',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    origin: text('origin'),
    contentSha256: text('content_sha256'),
    rowsRead: integer('rows_read').notNull().default(0),
    rowsInserted: integer('rows_inserted').notNull().default(0),
    rowsUpdated: integer('rows_updated').notNull().default(0),
    rowsDeleted: integer('rows_deleted').notNull().default(0),
    eventsEmitted: integer('events_emitted').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('source_sync_run_source_started_idx').on(t.source, t.startedAt),
    check('source_sync_run_source_ck', oneOf('source', SYNC_SOURCES)),
    check('source_sync_run_status_ck', oneOf('status', SYNC_STATUSES)),
  ],
);

export const sourceFile = pgTable(
  'source_file',
  {
    source: text('source').notNull(),
    url: text('url').notNull(),
    sha256: text('sha256').notNull(),
    rows: integer('rows').notNull().default(0),
    loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.source, t.url] }), check('source_file_source_ck', oneOf('source', SYNC_SOURCES))],
);

export const jobCursor = pgTable('job_cursor', {
  name: text('name').primaryKey(),
  lastId: bigint('last_id', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
