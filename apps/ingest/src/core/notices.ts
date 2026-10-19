import {
  EVENT_SEVERITY,
  NOTICE_DESTINATION,
  type EventKind,
  type NoticeSource,
  type NoticeType,
} from '@rejectradar/contracts';
import { changeEvent, notice } from '@rejectradar/db';
import { sql } from 'drizzle-orm';
import type { Tx } from './sync-run';

const BATCH_SIZE = 500;

function* batches<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += BATCH_SIZE) yield items.slice(i, i + BATCH_SIZE);
}

export interface NoticeInput {
  source: NoticeSource;
  sourceKey: string;
  noticeType: NoticeType;
  noticeOn: string;
  originCountry: string | null;
  commodityId: number;
  hazardIds: number[];
  productText: string | null;
  firmName: string | null;
  title: string;
  url: string | null;
}

export interface UpsertedNotice {
  id: number;
  inserted: boolean;
}

/**
 * Inserts notices and updates changed ones. Returns only the rows that were inserted or changed, keyed by
 * `sourceKey`, so a re-run over identical data returns an empty map (and therefore emits no events).
 * A repeated key within one call keeps its last occurrence.
 */
export async function upsertNotices(tx: Tx, rows: NoticeInput[]): Promise<Map<string, UpsertedNotice>> {
  const result = new Map<string, UpsertedNotice>();
  const unique = [...new Map(rows.map((row) => [JSON.stringify([row.source, row.sourceKey]), row])).values()];

  for (const batch of batches(unique)) {
    const returned = await tx
      .insert(notice)
      .values(batch.map((row) => ({ ...row, destination: NOTICE_DESTINATION[row.source] })))
      .onConflictDoUpdate({
        target: [notice.source, notice.sourceKey],
        set: {
          title: sql`excluded.title`,
          productText: sql`excluded.product_text`,
          commodityId: sql`excluded.commodity_id`,
          hazardIds: sql`excluded.hazard_ids`,
          noticeOn: sql`excluded.notice_on`,
          originCountry: sql`excluded.origin_country`,
          firmName: sql`excluded.firm_name`,
          url: sql`excluded.url`,
        },
        setWhere: sql`(${notice.title}, ${notice.productText}, ${notice.commodityId}, ${notice.hazardIds}, ${notice.noticeOn}, ${notice.originCountry}, ${notice.firmName}, ${notice.url})
          is distinct from
          (excluded.title, excluded.product_text, excluded.commodity_id, excluded.hazard_ids, excluded.notice_on, excluded.origin_country, excluded.firm_name, excluded.url)`,
      })
      .returning({ id: notice.id, sourceKey: notice.sourceKey, inserted: sql<boolean>`(xmax = 0)` });
    for (const row of returned) result.set(row.sourceKey, { id: row.id, inserted: row.inserted });
  }
  return result;
}

export interface EventInput {
  source: NoticeSource;
  sourceKey: string;
  kind: EventKind;
  occurredOn: string;
  requiresFirm: boolean;
  originCountry: string | null;
  commodityId: number | null;
  hazardIds: number[];
  noticeId: number | null;
  payload?: Record<string, unknown>;
}

/** Inserts change events with `severity` and `destination` filled from the contracts tables; `firm_id` stays null. */
export async function insertEvents(tx: Tx, events: EventInput[]): Promise<number> {
  let total = 0;
  for (const batch of batches(events)) {
    const inserted = await tx
      .insert(changeEvent)
      .values(
        batch.map((event) => ({
          ...event,
          severity: EVENT_SEVERITY[event.kind],
          destination: NOTICE_DESTINATION[event.source],
          payload: event.payload ?? {},
        })),
      )
      .returning({ id: changeEvent.id });
    total += inserted.length;
  }
  return total;
}
