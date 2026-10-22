import { FIRM_RECORD_SOURCES, type FirmRecordSource } from '@rejectradar/contracts';
import {
  auFailingFood,
  changeEvent,
  fdaRefusal,
  firm,
  firmFei,
  importAlertListing,
  matchReview,
  notice,
} from '@rejectradar/db';
import { and, eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { FirmRef, LinkPlan, NewFirm, RecordLink, Tx } from './types';

/** Rows per insert of firms, FEIs and reviews. */
const INSERT_BATCH = 500;
/** Records per `update … from (values …)`. */
const UPDATE_BATCH = 1000;

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Where a source keeps its records: the table, its key column and its firm column (all three have `link_score`). */
export interface RecordTable {
  table: PgTable;
  key: PgColumn;
  firmId: PgColumn;
}

export const RECORD_TABLES: Readonly<Record<FirmRecordSource, RecordTable>> = {
  fda_refusal: { table: fdaRefusal, key: fdaRefusal.sourceKey, firmId: fdaRefusal.firmId },
  import_alert: { table: importAlertListing, key: importAlertListing.listingKey, firmId: importAlertListing.firmId },
  au_ifis: { table: auFailingFood, key: auFailingFood.sourceKey, firmId: auFailingFood.firmId },
};

export interface ApplyResult {
  /** Each new firm's id, at its `NewFirm.index`. */
  firmIds: number[];
  /** The new firms and every existing firm the plan gives a record or an FEI, ascending. */
  touchedFirmIds: number[];
  /** The notices and change events whose firm the final propagateFirmIds changed. */
  propagated: { notices: number; events: number };
}

/**
 * Writes a plan with the caller's transaction (spec §8.2): the new firms, their FEIs, each record's firm and
 * `link_score`, the reviews, and last the firm of every notice and change event (propagateFirmIds). A record linked
 * since it was loaded keeps its firm.
 */
export async function applyLinkPlan(tx: Tx, plan: LinkPlan): Promise<ApplyResult> {
  const firmIds = await insertFirms(tx, plan.newFirms);
  const firmIdOf = (ref: FirmRef): number => {
    if (ref.kind === 'existing') return ref.id;
    const id = firmIds[ref.index];
    if (id === undefined) throw new Error(`The plan refers to new firm ${ref.index}, which it does not create`);
    return id;
  };

  for (const batch of chunks(plan.feis, INSERT_BATCH)) {
    await tx
      .insert(firmFei)
      .values(batch.map(({ fei, firm: ref, firstSeen }) => ({ fei, firmId: firmIdOf(ref), firstSeen })));
  }
  for (const source of FIRM_RECORD_SOURCES) {
    const links = plan.links.filter((link) => link.source === source);
    for (const batch of chunks(links, UPDATE_BATCH)) await linkRecords(tx, RECORD_TABLES[source], batch, firmIdOf);
  }
  for (const batch of chunks(plan.reviews, INSERT_BATCH)) {
    await tx.insert(matchReview).values(
      batch.map((review) => ({
        source: review.source,
        sourceKey: review.key,
        firmId: firmIdOf(review.firm),
        candidateFirmId: firmIdOf(review.candidate),
        score: String(review.score),
        reason: review.reason,
        evidence: review.evidence,
        status: 'open',
      })),
    );
  }
  const propagated = await propagateFirmIds(tx);

  const touched = new Set(firmIds);
  for (const { firm: ref } of [...plan.links, ...plan.feis]) touched.add(firmIdOf(ref));
  return { firmIds, touchedFirmIds: [...touched].sort((a, b) => a - b), propagated };
}

/** Inserts the new firms in index order and returns their ids by index. */
async function insertFirms(tx: Tx, newFirms: readonly NewFirm[]): Promise<number[]> {
  const ids: number[] = [];
  const inIndexOrder = [...newFirms].sort((a, b) => a.index - b.index);
  for (const batch of chunks(inIndexOrder, INSERT_BATCH)) {
    // A multi-row insert returns its rows in the order of its values.
    const rows = await tx.insert(firm).values(batch.map(firmRow)).returning({ id: firm.id });
    batch.forEach(({ index }, i) => {
      ids[index] = rows[i].id;
    });
  }
  return ids;
}

/** A new firm's row: its name and normalised address (P3-D6, all null without one) and the date it was first seen. */
export function firmRow({
  displayName,
  nameNorm,
  address,
  firstSeen,
}: Pick<NewFirm, 'displayName' | 'nameNorm' | 'address' | 'firstSeen'>): typeof firm.$inferInsert {
  return {
    displayName,
    nameNorm,
    countryCode: address?.countryCode ?? null,
    region: address?.region ?? null,
    city: address?.city ?? null,
    postalCode: address?.postalCode ?? null,
    addressNorm: address?.addressNorm ?? null,
    firstSeen,
  };
}

/** Sets `firm_id` and `link_score` on the batch's records that are still unlinked. */
async function linkRecords(
  tx: Tx,
  records: RecordTable,
  links: readonly RecordLink[],
  firmIdOf: (ref: FirmRef) => number,
): Promise<void> {
  const values = sql.join(
    links.map(({ key, firm: ref, score }) => sql`(${key}::text, ${firmIdOf(ref)}::bigint, ${score}::numeric)`),
    sql`, `,
  );
  await tx.execute(sql`
    update ${records.table} set firm_id = v.firm_id, link_score = v.link_score
    from (values ${values}) as v (source_key, firm_id, link_score)
    where ${records.key} = v.source_key and ${records.firmId} is null`);
}

/**
 * Gives each notice and change event of a record the firm the record has now (spec §6.5), wherever the two differ: an
 * event written after its record was linked, a notice whose record moved to another firm, and one whose record's link
 * was cleared (P3-D8), which loses its firm. A notice or event belongs to the record with its source and key. Returns
 * how many rows changed.
 */
export async function propagateFirmIds(tx: Tx): Promise<{ notices: number; events: number }> {
  let notices = 0;
  let events = 0;
  for (const source of FIRM_RECORD_SOURCES) {
    const { table, key, firmId } = RECORD_TABLES[source];
    const noticeRows = await tx
      .update(notice)
      .set({ firmId: sql`${firmId}` })
      .from(table)
      .where(
        and(eq(notice.source, source), eq(notice.sourceKey, key), sql`${notice.firmId} is distinct from ${firmId}`),
      );
    notices += noticeRows.rowCount ?? 0;
    const eventRows = await tx
      .update(changeEvent)
      .set({ firmId: sql`${firmId}` })
      .from(table)
      .where(
        and(
          eq(changeEvent.source, source),
          eq(changeEvent.sourceKey, key),
          sql`${changeEvent.firmId} is distinct from ${firmId}`,
        ),
      );
    events += eventRows.rowCount ?? 0;
  }
  return { notices, events };
}
