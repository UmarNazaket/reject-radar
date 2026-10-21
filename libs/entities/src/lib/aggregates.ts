import { FIRM_FACT_WINDOWS } from '@rejectradar/contracts';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './types';

/**
 * Recomputes the facts of spec §9.4 on every firm not merged away (P3-D9), or only on `firmIds`: `commodity_ids`,
 * `first_seen`, `last_notice_on`, `flags` (FirmFlags) and `metrics` (FirmMetrics). The windows count back from `today`
 * (YYYY-MM-DD) and nothing else, so the 12-month and 3-year counts age without new records (P3-D7). One statement; a
 * firm is written only when one of its facts changed. Returns how many firms were written.
 */
export async function refreshFirmAggregates(
  tx: DbOrTx,
  opts: { today: string; firmIds?: readonly number[] },
): Promise<number> {
  const { recentMonths, historyYears, topHazards } = FIRM_FACT_WINDOWS;
  const onlyAsked =
    opts.firmIds === undefined ? sql.empty() : sql`and id = any(${sql.param([...opts.firmIds])}::bigint[])`;
  // `collate "C"` orders text by code unit, as planLinks does, whatever the database's collation.
  const result = await tx.execute(sql`
    with
    -- A record is within a window when it is dated after the window's start.
    windows as (
      select (${opts.today}::date - make_interval(months => ${recentMonths}::int))::date as recent_start,
             (${opts.today}::date - make_interval(years => ${historyYears}::int))::date as history_start
    ),
    -- The firms to refresh: those not merged away, and only those asked for when the caller names them.
    targets as (
      select id from firm where id not in (select old_id from firm_alias) ${onlyAsked}
    ),
    -- FDA refusals and Australian failed tests, each of which has a notice. An Australian test is dated by its
    -- failure, else by its report month.
    rejections as (
      select firm_id, 'fda_refusal' as source, id, source_key, refusal_date as seen_on, commodity_id, hazard_ids,
             null::boolean as holding_order_match
      from fda_refusal where firm_id in (select id from targets)
      union all
      select firm_id, 'au_ifis', id, source_key, coalesce(failed_on, report_month), commodity_id, hazard_ids,
             holding_order_match
      from au_failing_food where firm_id in (select id from targets)
    ),
    -- Import Alert listings, dated by listing, else by first sighting. Only a red listing has a notice, which holds its
    -- commodity and hazards. A listing is current while it stands on a food alert that FDA still publishes.
    listings as (
      select l.firm_id, l.id, l.list, l.alert_number, l.listed_on, coalesce(l.listed_on, l.first_seen_on) as seen_on,
             l.removed_on is null and a.is_food and a.removed_at is null as is_current,
             n.commodity_id, coalesce(n.hazard_ids, '{}') as hazard_ids
      from import_alert_listing l
      join import_alert a on a.number = l.alert_number
      left join notice n on l.list = 'red' and n.source = 'import_alert' and n.source_key = l.listing_key
      where l.firm_id in (select id from targets)
    ),
    -- Per firm, over all its records: commodities, first and last dates, and the counts.
    totals as (
      select firm_id,
             array_agg(distinct commodity_id order by commodity_id) filter (where commodity_id is not null)
               as commodity_ids,
             min(seen_on) as first_seen,
             max(seen_on) filter (where has_notice) as last_notice_on,
             count(*) filter (where source = 'fda_refusal') as fda_refusals_total,
             count(*) filter (where source = 'fda_refusal' and seen_on > recent_start) as fda_refusals_12m,
             count(*) filter (where source = 'fda_refusal' and seen_on > history_start) as fda_refusals_3y,
             count(*) filter (where source = 'au_ifis') as au_failed_total,
             count(*) filter (where source = 'au_ifis' and seen_on > history_start) as au_failed_3y
      from (
        select firm_id, source, seen_on, commodity_id, true as has_notice from rejections
        union all
        select firm_id, 'import_alert', seen_on, commodity_id, list = 'red' from listings
      ) records
      cross join windows
      group by firm_id
    ),
    -- Per firm, its latest Australian failed test, by date, then key.
    latest_au as (
      select distinct on (firm_id) firm_id, coalesce(holding_order_match, false) as holding_order_match
      from rejections
      where source = 'au_ifis'
      order by firm_id, seen_on desc, source_key collate "C" desc
    ),
    -- Per firm and list, the alerts the firm is currently listed on, by number, each with the earliest date of its
    -- listings there (null when none has a date).
    alert_entries as (
      select firm_id, list,
             jsonb_agg(jsonb_build_object('alert', alert_number, 'listed_on', listed_on)
                       order by alert_number collate "C") as entries
      from (
        select firm_id, list, alert_number, min(listed_on) as listed_on
        from listings
        where is_current
        group by firm_id, list, alert_number
      ) alerts
      group by firm_id, list
    ),
    -- The hazard categories of the rejections within 3 years and of the current red listings: one row per record and
    -- category, so a record counts once per category it carries.
    hazard_categories as (
      select distinct r.firm_id, r.source, r.id, hazard.category
      from (
        select firm_id, source, id, hazard_ids from rejections cross join windows where seen_on > history_start
        union all
        select firm_id, 'import_alert', id, hazard_ids from listings where list = 'red' and is_current
      ) r
      cross join unnest(r.hazard_ids) as carried (hazard_id)
      join hazard on hazard.id = carried.hazard_id
      where hazard.category <> 'unclassified'
    ),
    -- Per firm, its most frequent categories, ties by name.
    top_hazards as (
      select firm_id, jsonb_agg(category order by rank) as categories
      from (
        select firm_id, category,
               row_number() over (partition by firm_id order by count(*) desc, category collate "C") as rank
        from hazard_categories
        group by firm_id, category
      ) ranked
      where rank <= ${topHazards}
      group by firm_id
    ),
    -- Every target's facts. A firm without records gets empty lists, zero counts, false and no dates.
    facts as (
      select targets.id,
             coalesce(totals.commodity_ids, '{}') as commodity_ids,
             totals.first_seen,
             totals.last_notice_on,
             jsonb_build_object(
               'import_alert_red', coalesce(red.entries, '[]'),
               'import_alert_green', coalesce(green.entries, '[]'),
               'fda_refusals_12m', coalesce(totals.fda_refusals_12m, 0),
               'fda_refusals_3y', coalesce(totals.fda_refusals_3y, 0),
               'au_failed_3y', coalesce(totals.au_failed_3y, 0),
               'au_holding_order', coalesce(latest_au.holding_order_match, false),
               'top_hazards_3y', coalesce(top_hazards.categories, '[]')
             ) as flags,
             jsonb_build_object(
               'fda_refusals_total', coalesce(totals.fda_refusals_total, 0),
               'au_failed_total', coalesce(totals.au_failed_total, 0),
               'import_alert_red_current', coalesce(jsonb_array_length(red.entries), 0),
               'import_alert_green_current', coalesce(jsonb_array_length(green.entries), 0)
             ) as metrics
      from targets
      left join totals on totals.firm_id = targets.id
      left join latest_au on latest_au.firm_id = targets.id
      left join alert_entries red on red.firm_id = targets.id and red.list = 'red'
      left join alert_entries green on green.firm_id = targets.id and green.list = 'green'
      left join top_hazards on top_hazards.firm_id = targets.id
    )
    update firm
    set commodity_ids = facts.commodity_ids,
        first_seen = facts.first_seen,
        last_notice_on = facts.last_notice_on,
        flags = facts.flags,
        metrics = facts.metrics,
        updated_at = now()
    from facts
    where firm.id = facts.id
      and (firm.commodity_ids, firm.first_seen, firm.last_notice_on, firm.flags, firm.metrics)
          is distinct from (facts.commodity_ids, facts.first_seen, facts.last_notice_on, facts.flags, facts.metrics)`);
  return result.rowCount ?? 0;
}
