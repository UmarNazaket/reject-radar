import { FIRM_RECORD_SOURCES, type FirmRecordSource } from '@rejectradar/contracts';
import {
  alert,
  auditLog,
  auFailingFood,
  bulkJobRow,
  changeEvent,
  type Database,
  dispute,
  fdaRefusal,
  firm,
  firmAlias,
  firmFei,
  importAlertListing,
  matchReview,
  notice,
  watchlistItem,
} from '@rejectradar/db';
import { and, eq, getTableName, inArray, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { refreshFirmAggregates } from './aggregates';
import { refreshFirmAltNames } from './alt-names';
import { firmRow, RECORD_TABLES } from './apply';
import { loadFirmRecords } from './load';
import { lockFirms } from './lock';
import { earliestSeenOn, latestRecord } from './plan-links';
import type { FirmRecord, Tx } from './types';

/** A merge: the firm kept, the firm merged into it, and the rows moved per table. */
export interface MergeResult {
  keptId: number;
  mergedId: number;
  /** Rows per table, by the table's name; `watchlist_item_deleted` counts the items dropped as duplicates. */
  moved: Record<string, number>;
}

/** A split: the firm split, the firm it created, and the rows moved per table. */
export interface SplitResult {
  fromId: number;
  newFirmId: number;
  /** Rows per table, by the table's name. */
  moved: Record<string, number>;
}

/** A record for splitFirm: its source and its key there. */
export interface RecordRef {
  source: FirmRecordSource;
  key: string;
}

/** The tables whose `firm_id` a merge simply re-points; reviews, watchlists, lookups and aliases take more care. */
const MERGE_REPOINTS: readonly PgTable[] = [
  fdaRefusal,
  importAlertListing,
  auFailingFood,
  notice,
  changeEvent,
  alert,
  bulkJobRow,
  dispute,
  firmFei,
];

/**
 * Spec §8.2, stable IDs: merges two firms in one transaction that holds the firm lock. The older firm, the smaller id,
 * is kept and takes every row that points at the other one. The merged firm keeps its row behind a `firm_alias` and is
 * never a link target again (P3-D9). The kept firm's facts are refreshed on `today` (YYYY-MM-DD), and the merge is
 * audited as `firm.merge` by `actorUserId`. Throws, writing nothing, when the two ids are one firm, or when a firm does
 * not exist or was merged away already.
 */
export async function mergeFirms(
  db: Database,
  input: { firmIds: readonly [number, number]; actorUserId: string | null; today: string },
): Promise<MergeResult> {
  const [first, second] = input.firmIds;
  if (first === second) throw new Error(`Firm ${first} cannot be merged with itself`);
  const keptId = Math.min(first, second);
  const mergedId = Math.max(first, second);
  return db.transaction(async (tx) => {
    await lockFirms(tx);
    await checkMergeable(tx, [keptId, mergedId]);
    const { moved, count } = movedRows();

    for (const table of MERGE_REPOINTS) {
      const result = await tx.execute(sql`update ${table} set firm_id = ${keptId} where firm_id = ${mergedId}`);
      count(getTableName(table), result.rowCount);
    }
    // A review counts once, whichever of its sides moved.
    const reviews = await tx.execute(sql`
      update match_review
      set firm_id = case when firm_id = ${mergedId} then ${keptId} else firm_id end,
          candidate_firm_id = case when candidate_firm_id = ${mergedId} then ${keptId} else candidate_firm_id end
      where firm_id = ${mergedId} or candidate_firm_id = ${mergedId}`);
    count('match_review', reviews.rowCount);
    // A review between the two firms now points the kept firm at itself: the merge decides it.
    await tx
      .update(matchReview)
      .set({ status: 'linked', decidedBy: input.actorUserId, decidedAt: sql`now()` })
      .where(and(eq(matchReview.firmId, keptId), eq(matchReview.candidateFirmId, keptId)));

    // An account watching both firms keeps the item it added first (by created_at, then id).
    const duplicates = await tx.execute(sql`
      delete from watchlist_item newer
      using watchlist_item older
      where older.org_id = newer.org_id
        and older.firm_id in (${keptId}, ${mergedId}) and newer.firm_id in (${keptId}, ${mergedId})
        and (older.created_at, older.id) < (newer.created_at, newer.id)`);
    count('watchlist_item_deleted', duplicates.rowCount);
    const items = await tx.update(watchlistItem).set({ firmId: keptId }).where(eq(watchlistItem.firmId, mergedId));
    count('watchlist_item', items.rowCount);

    // A month in which an account looked up both firms keeps the earlier lookup.
    const lookups = await tx.execute(sql`
      with moved as (
        delete from lookup_log where firm_id = ${mergedId} returning org_id, period, first_at
      )
      insert into lookup_log (org_id, firm_id, period, first_at)
      select org_id, ${keptId}::bigint, period, first_at from moved
      on conflict (org_id, firm_id, period) do update set first_at = least(lookup_log.first_at, excluded.first_at)`);
    count('lookup_log', lookups.rowCount);

    // Aliases stay one hop: the firms merged into the merged firm before now lead to the kept one.
    const aliases = await tx.update(firmAlias).set({ newId: keptId }).where(eq(firmAlias.newId, mergedId));
    count('firm_alias', aliases.rowCount);
    count('firm_alias', (await tx.insert(firmAlias).values({ oldId: mergedId, newId: keptId })).rowCount);

    await refreshFirmAltNames(tx, [keptId]);
    await refreshFirmAggregates(tx, { today: input.today, firmIds: [keptId] });
    await tx.insert(auditLog).values({
      actorUserId: input.actorUserId,
      action: 'firm.merge',
      targetType: 'firm',
      targetId: String(keptId),
      details: { mergedId, moved },
    });
    return { keptId, mergedId, moved };
  });
}

/**
 * Spec §8.2, stable IDs: in one transaction that holds the firm lock, moves `records` of firm `firmId` to a new firm,
 * with their notices and events, the alerts on those events, the disputes about the records, and the FEIs whose
 * refusals all moved. The new firm is named and placed as the latest of the records (P3-D6). Both firms' facts and
 * alternative names are refreshed on `today` (YYYY-MM-DD), and the split is audited as `firm.split` by `actorUserId`.
 * Throws, writing nothing, unless the records are some but not all of the firm's and every FEI's refusals stay on one
 * side.
 */
export async function splitFirm(
  db: Database,
  input: { firmId: number; records: readonly RecordRef[]; actorUserId: string | null; today: string },
): Promise<SplitResult> {
  const fromId = input.firmId;
  return db.transaction(async (tx) => {
    await lockFirms(tx);
    const records = await recordsToSplit(tx, fromId, input.records);
    const latest = latestRecord(records);
    const [{ id: newFirmId }] = await tx
      .insert(firm)
      .values(
        firmRow({
          displayName: latest.firmName,
          nameNorm: latest.nameNorm,
          address: latest.address,
          firstSeen: earliestSeenOn(records),
        }),
      )
      .returning({ id: firm.id });
    const { moved, count } = movedRows();

    for (const source of FIRM_RECORD_SOURCES) {
      const keys = records.filter((record) => record.source === source).map(({ key }) => key);
      if (keys.length === 0) continue;
      const { table, key, firmId } = RECORD_TABLES[source];
      const result = await tx.execute(sql`
        update ${table} set firm_id = ${newFirmId}
        where ${key} = any(${sql.param(keys)}::text[]) and ${firmId} = ${fromId}`);
      count(getTableName(table), result.rowCount);
    }
    // Notices, events and disputes belong to a record by its source and key.
    const sources = sql.param(records.map(({ source }) => source));
    const keys = sql.param(records.map(({ key }) => key));
    const ofRecords = (source: PgColumn, key: PgColumn): SQL =>
      sql`(${source}, ${key}) in (select * from unnest(${sources}::text[], ${keys}::text[]))`;
    const notices = await tx
      .update(notice)
      .set({ firmId: newFirmId })
      .where(and(eq(notice.firmId, fromId), ofRecords(notice.source, notice.sourceKey)));
    count('notice', notices.rowCount);
    const events = await tx
      .update(changeEvent)
      .set({ firmId: newFirmId })
      .where(and(eq(changeEvent.firmId, fromId), ofRecords(changeEvent.source, changeEvent.sourceKey)));
    count('change_event', events.rowCount);
    const eventIds = tx
      .select({ id: changeEvent.id })
      .from(changeEvent)
      .where(ofRecords(changeEvent.source, changeEvent.sourceKey));
    const alerts = await tx
      .update(alert)
      .set({ firmId: newFirmId })
      .where(and(eq(alert.firmId, fromId), inArray(alert.changeEventId, eventIds)));
    count('alert', alerts.rowCount);
    const disputes = await tx
      .update(dispute)
      .set({ firmId: newFirmId })
      .where(and(eq(dispute.firmId, fromId), ofRecords(dispute.source, dispute.sourceKey)));
    count('dispute', disputes.rowCount);
    // No FEI is on both sides, so each FEI of the moved refusals had all its refusals moved.
    const feis = [...new Set(records.flatMap(({ fei }) => (fei === null ? [] : [fei])))];
    if (feis.length > 0) {
      const held = await tx
        .update(firmFei)
        .set({ firmId: newFirmId })
        .where(and(eq(firmFei.firmId, fromId), inArray(firmFei.fei, feis)));
      count('firm_fei', held.rowCount);
    }

    await refreshFirmAltNames(tx, [fromId, newFirmId]);
    await refreshFirmAggregates(tx, { today: input.today, firmIds: [fromId, newFirmId] });
    await tx.insert(auditLog).values({
      actorUserId: input.actorUserId,
      action: 'firm.split',
      targetType: 'firm',
      targetId: String(fromId),
      details: { newFirmId, moved },
    });
    return { fromId, newFirmId, moved };
  });
}

/** The counts of a merge or split, under each table's name, leaving out the tables where nothing moved. */
function movedRows(): { moved: Record<string, number>; count: (table: string, rows: number | null) => void } {
  const moved: Record<string, number> = {};
  const count = (table: string, rows: number | null) => {
    if (rows) moved[table] = (moved[table] ?? 0) + rows;
  };
  return { moved, count };
}

/** Throws unless each of `ids` is a firm that was not merged away. */
async function checkMergeable(tx: Tx, ids: readonly number[]): Promise<void> {
  const rows = await tx
    .select({ id: firm.id, mergedInto: firmAlias.newId })
    .from(firm)
    .leftJoin(firmAlias, eq(firmAlias.oldId, firm.id))
    .where(inArray(firm.id, [...ids]));
  for (const id of ids) {
    const row = rows.find((found) => found.id === id);
    if (!row) throw new Error(`Firm ${id} does not exist`);
    if (row.mergedInto !== null) throw new Error(`Firm ${id} was merged into firm ${row.mergedInto}`);
  }
}

/**
 * The firm's records that `wanted` names, as loadFirmRecords reads them. Throws unless they are at least one, all the
 * firm's, not every record it has, and no FEI has refusals among them and among the records that stay.
 */
async function recordsToSplit(tx: Tx, fromId: number, wanted: readonly RecordRef[]): Promise<FirmRecord[]> {
  if (wanted.length === 0) throw new Error('A split needs at least one record');
  const idOf = ({ source, key }: RecordRef) => `${source} ${key}`;
  const firmRecords = new Map(
    (await loadFirmRecords(tx, { firmId: fromId })).map(({ record }) => [idOf(record), record]),
  );
  const moving = new Map<string, FirmRecord>();
  for (const ref of wanted) {
    const record = firmRecords.get(idOf(ref));
    if (!record) throw new Error(`${idOf(ref)} is not a record of firm ${fromId}`);
    moving.set(idOf(ref), record);
  }
  if (moving.size === firmRecords.size) throw new Error(`A split must leave firm ${fromId} at least one record`);
  const movingFeis = new Set([...moving.values()].map(({ fei }) => fei));
  for (const [id, { fei }] of firmRecords) {
    if (fei !== null && movingFeis.has(fei) && !moving.has(id)) {
      throw new Error(`FEI ${fei} has refusals on both sides of the split of firm ${fromId}`);
    }
  }
  return [...moving.values()];
}
