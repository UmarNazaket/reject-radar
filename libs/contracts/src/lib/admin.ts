import { z } from 'zod';
import type { BillingInterval, Role, SubscriptionStatus } from './accounts';
import type { BillingUsage, PlanSource } from './billing';
import { FIRM_RECORD_SOURCES, type FirmRecordSource, MATCH_REVIEW_STATUSES, type MatchReviewReason, type MatchReviewStatus } from './firms';
import { DISPUTE_STATUSES, type DisputeKind, type DisputeStatus } from './product';
import { RULE_MATCH_TYPES, RULE_SOURCES, type RuleMatchType, type RuleSource, type SyncSource, type SyncStatus } from './ingestion';
import type { SourceFreshness } from './notices';
import { PLAN_IDS, type PlanId, type PlanLimits } from './plans';

/** Runs of each source listed by `GET /v1/admin/sources`. */
export const ADMIN_RECENT_RUNS = 10;

/** One sync run as `source_sync_run` records it. Times are ISO 8601. */
export interface SyncRunItem {
  id: number;
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Where the run read from, such as a file URL; null when the source has one place. */
  origin: string | null;
  partial: boolean;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  eventsEmitted: number;
  error: string | null;
}

/** A source's health: its freshness, when the product shows one, and its newest runs first. */
export interface AdminSourceItem {
  source: SyncSource;
  /** Null for a source the product does not show a date for (the FDA charge-code list). */
  freshness: SourceFreshness | null;
  runs: SyncRunItem[];
}

/** `GET /v1/admin/sources`: every source, in `SYNC_SOURCES` order. */
export interface AdminSourcesResponse {
  sources: AdminSourceItem[];
}

/** A firm as the admin screens show it beside another: enough to tell two firms apart. */
export interface AdminFirmSummary {
  id: number;
  displayName: string;
  countryCode: string | null;
  city: string | null;
  feis: string[];
  /** FDA refusals, Import Alert listings and Australian failed tests linked to the firm. */
  records: number;
  /** The firm this one was merged into, when it was. */
  mergedInto: number | null;
}

/** `GET /v1/admin/match-reviews?status=`: a record the matcher was unsure about, its firm and the candidate firm. */
export const matchReviewQuery = z.object({ status: z.enum(MATCH_REVIEW_STATUSES).default('open') });
export type MatchReviewQuery = z.output<typeof matchReviewQuery>;

export interface MatchReviewItem {
  id: number;
  source: FirmRecordSource;
  sourceKey: string;
  reason: MatchReviewReason;
  score: number;
  /** The matcher's evidence and score parts, as it stored them. */
  evidence: Record<string, unknown>;
  status: MatchReviewStatus;
  firm: AdminFirmSummary;
  candidate: AdminFirmSummary;
  createdAt: string;
  decidedAt: string | null;
}

export interface MatchReviewsResponse {
  /** The newest 100 with the status asked for. */
  items: MatchReviewItem[];
}

/** `POST /v1/admin/match-reviews/:id/decision`: the same firm (merge them) or two firms (keep them apart). */
export const matchDecisionRequest = z.object({ same: z.boolean() });
export type MatchDecisionRequest = z.output<typeof matchDecisionRequest>;

const firmId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** `POST /v1/admin/firms/merge`: the older firm (the smaller id) is kept. */
export const mergeFirmsRequest = z.object({ firmIds: z.tuple([firmId, firmId]) });
export type MergeFirmsRequest = z.output<typeof mergeFirmsRequest>;

/** `POST /v1/admin/firms/:id/split`: the records that move to a new firm. */
export const splitFirmRequest = z.object({
  records: z.array(z.object({ source: z.enum(FIRM_RECORD_SOURCES), key: z.string().min(1).max(200) })).min(1).max(1000),
});
export type SplitFirmRequest = z.output<typeof splitFirmRequest>;

/** What a merge or split changed: the firms, and the rows moved per table. */
export interface FirmChangeResponse {
  keptId: number;
  /** The merged-away firm, or the firm a split created. */
  otherId: number;
  moved: Record<string, number>;
}

/** One record of a firm, as the split screen lists it. */
export interface AdminFirmRecord {
  source: FirmRecordSource;
  key: string;
  fei: string | null;
  /** The firm's name and address as the source wrote them. */
  firmName: string;
  address: string | null;
  /** `YYYY-MM-DD`. */
  seenOn: string;
}

/** `GET /v1/admin/firms/:id`: the firm and every record linked to it, newest first. */
export interface AdminFirmResponse {
  firm: AdminFirmSummary;
  records: AdminFirmRecord[];
}

/** `GET /v1/admin/disputes?status=`: the problems customers reported with "Report a problem". */
export const disputeReviewQuery = z.object({ status: z.enum(DISPUTE_STATUSES).default('open') });
export type DisputeReviewQuery = z.output<typeof disputeReviewQuery>;

export interface AdminDisputeItem {
  id: string;
  kind: DisputeKind;
  message: string;
  status: DisputeStatus;
  /** The staff note sent to the customer, once decided. */
  resolution: string | null;
  firm: AdminFirmSummary;
  /** The record the report is about, when it names one. */
  record: { source: FirmRecordSource; key: string } | null;
  org: { id: string; name: string };
  /** Null once the person who reported it has left. */
  reporter: { name: string; email: string } | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface DisputeReviewResponse {
  /** The newest 100 with the status asked for. */
  items: AdminDisputeItem[];
}

/** `PATCH /v1/admin/disputes/:id`: decide an open dispute once, with the note the customer is emailed. */
export const decideDisputeRequest = z.object({
  status: z.enum(['resolved', 'rejected']),
  resolution: z.string().trim().min(1).max(2000),
});
export type DecideDisputeRequest = z.output<typeof decideDisputeRequest>;

export interface DecideDisputeResponse {
  item: AdminDisputeItem;
  /** Whether the email to the reporter went out: not when they have left, today's email cap is used up or the send failed. */
  emailed: boolean;
}

/** Audit actions: staff ask for a taxonomy remap, and the daily sync job records each remap it runs for them. */
export const TAXONOMY_REMAP_REQUESTED = 'taxonomy.remap';
export const TAXONOMY_REMAP_RAN = 'taxonomy.remap_run';

/** Rules map records to commodities (`commodity_rule`) or hazards (`hazard_rule`); the ids of the two tables overlap. */
export const TAXONOMY_RULE_KINDS = ['commodity', 'hazard'] as const;
export type TaxonomyRuleKind = (typeof TAXONOMY_RULE_KINDS)[number];

/** Rules shown per list; a narrower filter finds the rest. */
export const TAXONOMY_RULE_LIMIT = 200;

const ruleField = z.string().trim().regex(/^[a-z][a-z_]{0,49}$/);

/** `GET /v1/admin/taxonomy-rules`: one kind's rules in evaluation order (priority, then id), narrowed by source, field, target or pattern text. */
export const taxonomyRuleQuery = z.object({
  kind: z.enum(TAXONOMY_RULE_KINDS).default('commodity'),
  source: z.enum(RULE_SOURCES).optional(),
  field: ruleField.optional(),
  target: z.coerce.number().int().min(1).max(32767).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
export type TaxonomyRuleQuery = z.output<typeof taxonomyRuleQuery>;

export interface AdminTaxonomyRule {
  id: number;
  kind: TaxonomyRuleKind;
  source: RuleSource;
  field: string;
  matchType: RuleMatchType;
  pattern: string;
  /** The commodity or hazard id. */
  targetId: number;
  priority: number;
}

export interface TaxonomyRulesResponse {
  items: AdminTaxonomyRule[];
  /** More rules match than the list shows. */
  more: boolean;
  /** Every source and field a rule of this kind uses, for the filters and the form. */
  fields: { source: RuleSource; field: string }[];
}

/** `PATCH /v1/admin/taxonomy-rules/:kind/:id`. Keyword and exact patterns are stored normalised, as the classifier compares them. */
export const taxonomyRuleRequest = z.object({
  source: z.enum(RULE_SOURCES),
  field: ruleField,
  matchType: z.enum(RULE_MATCH_TYPES),
  pattern: z.string().trim().min(1).max(200),
  targetId: z.number().int().min(1).max(32767),
  priority: z.number().int().min(0).max(32767),
});
export type TaxonomyRuleRequest = z.output<typeof taxonomyRuleRequest>;

/** `POST /v1/admin/taxonomy-rules`. */
export const createTaxonomyRuleRequest = taxonomyRuleRequest.extend({ kind: z.enum(TAXONOMY_RULE_KINDS) });
export type CreateTaxonomyRuleRequest = z.output<typeof createTaxonomyRuleRequest>;

/**
 * `POST /v1/admin/taxonomy-rules/preview`: classifies a sample record (its text per field) with the stored rules, and
 * again with an unsaved rule added, or put in place of the stored rule `id`.
 */
export const taxonomyPreviewRequest = z.object({
  source: z.enum(RULE_SOURCES).exclude(['*']),
  fields: z.record(ruleField, z.string().max(2000)).refine((fields) => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 10),
  rule: createTaxonomyRuleRequest.extend({ id: z.number().int().min(1).optional() }).optional(),
});
export type TaxonomyPreviewRequest = z.output<typeof taxonomyPreviewRequest>;

export interface TaxonomyClassification {
  commodityId: number;
  hazardIds: number[];
}

export interface TaxonomyPreviewResponse {
  current: TaxonomyClassification;
  /** Null without an unsaved rule. */
  withRule: TaxonomyClassification | null;
}

/** `GET` and `POST /v1/admin/taxonomy/remap`: the last request for a remap, and the last remap the daily sync job ran. */
export interface TaxonomyRemapStatus {
  requested: { at: string; by: string | null } | null;
  lastRun: { at: string; updated: Record<string, number> } | null;
  /** A request is newer than the last run; the next daily sync job runs it. */
  waiting: boolean;
}

/** `GET /v1/admin/orgs?q=`: the newest 50 accounts, or those whose name or a member's email contains `q`. */
export const adminOrgQuery = z.object({ q: z.string().trim().min(1).max(200).optional() });
export type AdminOrgQuery = z.output<typeof adminOrgQuery>;

export interface AdminOrgItem {
  id: string;
  name: string;
  plan: PlanId;
  source: PlanSource;
  members: number;
  createdAt: string;
  deactivatedAt: string | null;
}

export interface AdminOrgsResponse {
  items: AdminOrgItem[];
}

/** `GET /v1/admin/orgs/:id`: the account's plan and where it comes from, this month's usage, and its members. */
export interface AdminOrgResponse {
  org: { id: string; name: string; createdAt: string; planOverride: PlanId | null; deactivatedAt: string | null };
  plan: PlanId;
  source: PlanSource;
  limits: PlanLimits;
  usage: BillingUsage;
  /** The Paddle subscription, when the account has had one. */
  subscription: { status: SubscriptionStatus; interval: BillingInterval | null; currentPeriodEnd: string | null; cancelAt: string | null } | null;
  members: { userId: string; name: string; email: string; role: Role; emailVerified: boolean; joinedAt: string }[];
}

/** `PATCH /v1/admin/orgs/:id`: grant a plan (Enterprise, mostly) whatever the account pays for, or clear the grant. */
export const planOverrideRequest = z.object({ planOverride: z.enum(PLAN_IDS).nullable() });
export type PlanOverrideRequest = z.output<typeof planOverrideRequest>;

/** Audit entries per page. */
export const AUDIT_PAGE_SIZE = 50;

/** `GET /v1/admin/audit?action=&cursor=`: newest first; `action` matches the start, so `firm.` finds merges and splits. */
export const auditQuery = z.object({
  action: z.string().trim().min(1).max(100).optional(),
  cursor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type AuditQuery = z.output<typeof auditQuery>;

export interface AuditEntry {
  id: number;
  at: string;
  /** Null for the sync jobs, or a person who has left. */
  actor: { name: string; email: string } | null;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
}

export interface AuditResponse {
  items: AuditEntry[];
  /** The cursor of the next, older page; null on the last one. */
  next: number | null;
}
