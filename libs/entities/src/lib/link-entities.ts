import {
  FIRM_RECORD_SOURCES,
  type FirmRecordSource,
  MATCH_REVIEW_REASONS,
  type MatchReviewReason,
} from '@rejectradar/contracts';
import type { Database } from '@rejectradar/db';
import { refreshFirmAggregates } from './aggregates';
import { refreshFirmAltNames } from './alt-names';
import { applyLinkPlan } from './apply';
import { loadLinkInput } from './load';
import { planLinks } from './plan-links';

/** What one linking run did. */
export interface LinkRunResult {
  /** The unlinked records loaded, per source. */
  records: Record<FirmRecordSource, number>;
  firmsCreated: number;
  /** The records the plan links. */
  linked: number;
  /** The FEIs the plan gives to firms. */
  feisAssigned: number;
  /** The reviews opened, per reason. */
  reviews: Record<MatchReviewReason, number>;
  /** The notices and change events whose firm changed. */
  noticesUpdated: number;
  eventsUpdated: number;
  /** The firms whose facts changed. */
  firmsRefreshed: number;
  /** Wall time, in milliseconds. */
  ms: number;
}

/**
 * The `entities:link` run (spec §8.2): loads the unlinked records and plans their links, then, in one transaction,
 * applies the plan, refreshes the alternative names of the firms it touched and the facts of every firm (P3-D7) on
 * `today` (YYYY-MM-DD). The transaction runs even when there is nothing to link, so that events written since their
 * record was linked get its firm and the 12-month and 3-year counts age.
 */
export async function linkEntities(db: Database, opts: { today: string }): Promise<LinkRunResult> {
  const started = performance.now();
  const input = await loadLinkInput(db);
  const plan = planLinks(input);
  const { propagated, firmsRefreshed } = await db.transaction(async (tx) => {
    const applied = await applyLinkPlan(tx, plan);
    await refreshFirmAltNames(tx, applied.touchedFirmIds);
    const refreshed = await refreshFirmAggregates(tx, { today: opts.today });
    return { propagated: applied.propagated, firmsRefreshed: refreshed };
  });
  const sources = input.records.map(({ source }) => source);
  const reasons = plan.reviews.map(({ reason }) => reason);
  return {
    records: tally(FIRM_RECORD_SOURCES, sources),
    firmsCreated: plan.newFirms.length,
    linked: plan.links.length,
    feisAssigned: plan.feis.length,
    reviews: tally(MATCH_REVIEW_REASONS, reasons),
    noticesUpdated: propagated.notices,
    eventsUpdated: propagated.events,
    firmsRefreshed,
    ms: Math.round(performance.now() - started),
  };
}

/** How many of `values` are each of `keys`. */
function tally<K extends string>(keys: readonly K[], values: readonly K[]): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}
