import {
  BILLING_INTERVALS,
  EMAIL_DELIVERY_STATUSES,
  EMAIL_KINDS,
  EMAIL_TOKEN_PURPOSES,
  INVITE_ROLES,
  LOCALES,
  PLAN_IDS,
  ROLES,
  SUBSCRIPTION_STATUSES,
} from '@rejectradar/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
import { oneOf } from './checks';
import { changeEvent, commodity, firm, hazard } from './reference';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const org = pgTable('org', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  planOverride: text('plan_override'),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    locale: text('locale').notNull().default('en'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    failedLogins: smallint('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('app_user_email_lower_uq').on(sql`lower(${t.email})`),
    check('app_user_locale_ck', oneOf('locale', LOCALES)),
  ],
);

export const membership = pgTable(
  'membership',
  {
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index('membership_user_idx').on(t.userId),
    check('membership_role_ck', oneOf('role', ROLES)),
  ],
);

export const invite = pgTable(
  'invite',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => appUser.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invite_token_hash_uq').on(t.tokenHash),
    index('invite_org_idx').on(t.orgId),
    // Finds an account's pending invite for an email, whatever its case (P4-D8, P4-D12).
    index('invite_org_email_idx').on(t.orgId, sql`lower(${t.email})`),
    check('invite_role_ck', oneOf('role', INVITE_ROLES)),
  ],
);

export const refreshToken = pgTable(
  'refresh_token',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_token_hash_uq').on(t.tokenHash),
    index('refresh_token_user_idx').on(t.userId),
    index('refresh_token_family_idx').on(t.familyId),
  ],
);

export const emailToken = pgTable(
  'email_token',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('email_token_hash_uq').on(t.tokenHash),
    index('email_token_user_idx').on(t.userId),
    check('email_token_purpose_ck', oneOf('purpose', EMAIL_TOKEN_PURPOSES)),
  ],
);

export const subscription = pgTable(
  'subscription',
  {
    orgId: uuid('org_id').primaryKey().references(() => org.id, { onDelete: 'cascade' }),
    paddleCustomerId: text('paddle_customer_id'),
    paddleSubscriptionId: text('paddle_subscription_id'),
    plan: text('plan').notNull().default('free'),
    interval: text('interval'),
    status: text('status').notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscription_paddle_sub_uq').on(t.paddleSubscriptionId),
    check('subscription_plan_ck', oneOf('plan', PLAN_IDS)),
    check('subscription_status_ck', oneOf('status', SUBSCRIPTION_STATUSES)),
    check('subscription_interval_ck', oneOf('interval', BILLING_INTERVALS)),
  ],
);

export const paddleEvent = pgTable('paddle_event', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  payload: jsonb('payload'),
});

export const lookupLog = pgTable(
  'lookup_log',
  {
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    firmId: bigint('firm_id', { mode: 'number' }).notNull().references(() => firm.id),
    period: text('period').notNull(),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.firmId, t.period] })],
);

export const usageCounter = pgTable(
  'usage_counter',
  {
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    lookups: integer('lookups').notNull().default(0),
    bulkRows: integer('bulk_rows').notNull().default(0),
    apiCalls: integer('api_calls').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.period] })],
);

export const watchlistItem = pgTable(
  'watchlist_item',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firm.id),
    originCountry: text('origin_country'),
    commodityId: integer('commodity_id').references(() => commodity.id),
    destination: text('destination'),
    hazardId: integer('hazard_id').references(() => hazard.id),
    topicKey: text('topic_key'),
    inputName: text('input_name'),
    label: text('label'),
    notes: text('notes'),
    addedBy: uuid('added_by').references(() => appUser.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('watchlist_item_org_firm_uq').on(t.orgId, t.firmId).where(sql`kind = 'firm'`),
    uniqueIndex('watchlist_item_org_topic_uq').on(t.orgId, t.topicKey).where(sql`kind = 'topic'`),
    // The two unique indexes are partial, so they can't serve "where org_id = $1" on its own (spec §7).
    index('watchlist_item_org_idx').on(t.orgId),
    index('watchlist_item_firm_idx').on(t.firmId),
    index('watchlist_item_topic_idx').on(t.originCountry, t.commodityId),
    check(
      'watchlist_item_kind_ck',
      sql`(kind = 'firm' and firm_id is not null and topic_key is null) or (kind = 'topic' and firm_id is null and topic_key is not null and origin_country is not null)`,
    ),
  ],
);

export const alert = pgTable(
  'alert',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    changeEventId: bigint('change_event_id', { mode: 'number' }).notNull().references(() => changeEvent.id),
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firm.id),
    severity: text('severity').notNull(),
    createdAt: createdAt(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('alert_org_event_uq').on(t.orgId, t.changeEventId),
    index('alert_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

export const notificationPref = pgTable('notification_pref', {
  userId: uuid('user_id').primaryKey().references(() => appUser.id, { onDelete: 'cascade' }),
  instantHigh: boolean('instant_high').notNull().default(true),
  digest: text('digest').notNull().default('daily'),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailDelivery = pgTable(
  'email_delivery',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').references(() => appUser.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    providerId: text('provider_id'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('email_delivery_created_idx').on(t.createdAt),
    check('email_delivery_kind_ck', oneOf('kind', EMAIL_KINDS)),
    check('email_delivery_status_ck', oneOf('status', EMAIL_DELIVERY_STATUSES)),
  ],
);

export const bulkJob = pgTable(
  'bulk_job',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
    fileName: text('file_name').notNull(),
    status: text('status').notNull().default('queued'),
    total: integer('total').notNull(),
    processed: integer('processed').notNull().default(0),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('bulk_job_org_idx').on(t.orgId)],
);

export const bulkJobRow = pgTable(
  'bulk_job_row',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid('job_id').notNull().references(() => bulkJob.id, { onDelete: 'cascade' }),
    rowNr: integer('row_nr').notNull(),
    inputName: text('input_name').notNull(),
    inputCountry: text('input_country'),
    inputCity: text('input_city'),
    inputFei: text('input_fei'),
    status: text('status').notNull().default('pending'),
    firmId: bigint('firm_id', { mode: 'number' }).references(() => firm.id),
    score: numeric('score', { precision: 5, scale: 4 }),
    candidates: jsonb('candidates').notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    index('bulk_job_row_job_row_idx').on(t.jobId, t.rowNr),
    index('bulk_job_row_job_status_idx').on(t.jobId, t.status),
  ],
);

export const dispute = pgTable(
  'dispute',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => appUser.id, { onDelete: 'set null' }),
    firmId: bigint('firm_id', { mode: 'number' }).notNull().references(() => firm.id),
    source: text('source'),
    sourceKey: text('source_key'),
    kind: text('kind').notNull().default('other'),
    message: text('message').notNull(),
    status: text('status').notNull().default('open'),
    resolution: text('resolution'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('dispute_status_idx').on(t.status), index('dispute_org_idx').on(t.orgId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);

export const apiKey = pgTable(
  'api_key',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_key_hash_uq').on(t.keyHash), index('api_key_org_idx').on(t.orgId)],
);
