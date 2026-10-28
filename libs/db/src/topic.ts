import type { TopicFields } from '@rejectradar/contracts';
import { type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';

type Column = SQL | AnyPgColumn;

/** Where an event (a notice, a change event) keeps the four topic parts. */
export interface TopicColumns {
  originCountry: Column;
  commodityId: Column;
  destination: Column;
  hazardIds: Column;
}

/** Where a watched topic keeps them: columns of `watchlist_item`, or of a `values` list. */
export interface ItemTopicColumns {
  originCountry: Column;
  commodityId: Column;
  destination: Column;
  hazardId: Column;
}

/** The commodity itself or any commodity below it; `commodity.ancestor_ids` excludes the commodity itself. */
export function commodityWithin(column: Column, commodityId: number): SQL {
  return sql`${column} in (select id from commodity where id = ${commodityId} or ${commodityId} = any(ancestor_ids))`;
}

/** Rows of an event table that fall inside one topic: each part the topic leaves out matches anything. */
export function topicFilter(cols: TopicColumns, topic: TopicFields): SQL {
  const parts: SQL[] = [sql`${cols.originCountry} = ${topic.originCountry}`];
  if (topic.commodityId !== null) parts.push(commodityWithin(cols.commodityId, topic.commodityId));
  if (topic.destination !== null) parts.push(sql`${cols.destination} = ${topic.destination}`);
  if (topic.hazardId !== null) parts.push(sql`${topic.hazardId} = any(${cols.hazardIds})`);
  return sql.join(parts, sql` and `);
}

/**
 * The join condition between one event and one watched topic (spec §11): same origin; the item's commodity is
 * unset, the event's own or one of its ancestors; the item's destination is unset or the event's; the item's
 * hazard is unset or among the event's hazards. `eventCommodityAncestors` is an int[] expression (a column or a scalar subquery) for the event.
 */
export function topicMatchesItem(event: TopicColumns, item: ItemTopicColumns, eventCommodityAncestors: Column): SQL {
  return sql`(${item.originCountry} = ${event.originCountry}
    and (${item.commodityId} is null or ${item.commodityId} = ${event.commodityId} or ${item.commodityId} = any(${eventCommodityAncestors}::int[]))
    and (${item.destination} is null or ${item.destination} = ${event.destination})
    and (${item.hazardId} is null or ${item.hazardId} = any(${event.hazardIds})))`;
}
