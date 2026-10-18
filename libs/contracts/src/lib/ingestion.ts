import type { Destination } from './destinations';

/** Sources a sync run (`source_sync_run`, `source_file`) can belong to. */
export const SYNC_SOURCES = ['fda_charge_codes', 'fda_refusals', 'import_alerts', 'rasff', 'uk_bn', 'au_ifis', 'eu_mrl'] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

export const SYNC_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Sources that produce rows in the unified `notice` table. */
export const NOTICE_SOURCES = ['fda_refusal', 'import_alert', 'rasff', 'uk_bn', 'au_ifis'] as const;
export type NoticeSource = (typeof NOTICE_SOURCES)[number];

/** Sources a taxonomy rule can target: any source (`*`), a notice source, or FDA charge codes. */
export const RULE_SOURCES = ['*', ...NOTICE_SOURCES, 'fda_charge_code'] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export const RULE_MATCH_TYPES = ['code_prefix', 'exact', 'keyword'] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export const NOTICE_TYPES = [
  'refusal',
  'import_alert_listing',
  'rasff_alert',
  'rasff_border_rejection',
  'rasff_information',
  'rasff_other',
  'uk_border_notification',
  'au_failed_test',
] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

export const EVENT_KINDS = [
  'fda_refusal',
  'import_alert_listed',
  'import_alert_delisted',
  'au_failed_test',
  'rasff_notification',
  'uk_border_notification',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const SEVERITIES = ['high', 'normal'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const LISTS = ['red', 'green'] as const;
export type AlertList = (typeof LISTS)[number];

/** Severity of each change-event kind (spec §6.5). */
export const EVENT_SEVERITY: Readonly<Record<EventKind, Severity>> = {
  fda_refusal: 'high',
  import_alert_listed: 'high',
  import_alert_delisted: 'normal',
  au_failed_test: 'high',
  rasff_notification: 'normal',
  uk_border_notification: 'normal',
};

/** Border region each notice source reports on. */
export const NOTICE_DESTINATION: Readonly<Record<NoticeSource, Destination>> = {
  fda_refusal: 'US',
  import_alert: 'US',
  rasff: 'EU',
  uk_bn: 'UK',
  au_ifis: 'AU',
};
