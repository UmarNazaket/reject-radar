import { changeEvent, matchReview, notice } from '@rejectradar/db';
import type { RuleSet } from '@rejectradar/taxonomy';
import { and, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgInsertValue, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { SyncDeps } from './deps';
import type { FetchResult } from './http';
import { insertEvents, upsertNotices, type EventInput, type NoticeInput } from './notices';
import { listMonthlyCsvResources, loadedFile, recordFile, type MonthlyResource } from './source-files';
import { eventsForRun, runSync, type SyncRunResult, type Tx } from './sync-run';

const BATCH_SIZE = 500;
const KEY_CHUNK = 2000;

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

export interface Classification {
  commodityId: number;
  hazardIds: number[];
}

export type Classified<R> = R & Classification;

/** A parsed row of a monthly file: its key and its origin country as the file writes it. */
export interface MonthlyRow {
  sourceKey: string;
  countryName: string | null;
}

/** What a monthly-file source (UK border notifications, Australian failing food) tells {@link syncMonthlyFiles}. */
export interface MonthlyFileSource<R extends MonthlyRow, TTable extends PgTable> {
  source: 'uk_bn' | 'au_ifis';
  /** The CKAN `package_show` URL that lists one CSV per month. */
  packageUrl: string;
  /** The typed table; it has a unique `source_key` column. */
  table: TTable;
  keyColumn: PgColumn;
  /** The typed table's column that stores `countryName`, which corrected rows pair on. */
  countryNameColumn: PgColumn;
  /**
   * Firm-level sources only, whose table has `firmId` and `linkScore`: the typed-row columns a record is linked to its
   * firm on (P3-D8). A load that changes them on a stored row clears its link, so `entities:link` relinks it. Only these
   * sources' records have match reviews, which follow a corrected row to its new key.
   */
  linkIdentity?: PgColumn[];
  /** Reads one downloaded file; an error is reported with the file's URL. */
  parse(file: FetchResult, resource: MonthlyResource): R[];
  classify(rules: RuleSet, row: R): Classification;
  /** The typed row as stored, `sourceKey` included; every other value is overwritten when it changes. */
  typedRow(row: Classified<R>): PgInsertValue<TTable>;
  notice(row: Classified<R>, url: string): NoticeInput;
  event(row: Classified<R>, noticeId: number): EventInput;
}

/** A monthly file that is new or changed since it was last loaded. */
interface ChangedFile<R> {
  resource: MonthlyResource;
  sha256: string;
  /** False for a file never loaded before. */
  loadedBefore: boolean;
  rows: Classified<R>[];
}

/** What a row is paired on, from its notice and its typed row. */
interface PairFields {
  sourceKey: string;
  noticeOn: string;
  countryName: string | null;
  productText?: string | null;
  firmName?: string | null;
}

/**
 * The fields a corrected row keeps: its date, origin country, product and (Australia only) producer. The country is the
 * text the file gives, not its code, so a later change to the country aliases cannot stop a stored row from pairing.
 * UK notices carry no firm, so the firm part is always null for them.
 */
const pairKey = (p: PairFields): string => JSON.stringify([p.noticeOn, p.countryName, p.productText ?? null, p.firmName ?? null]);

/**
 * Pairs the keys a changed file no longer holds with its new keys that describe the same record (same
 * {@link pairKey}), in file order: each pair is one corrected row, not a deletion plus an insertion.
 */
function pairCorrections(gone: readonly StoredNotice[], added: readonly PairFields[]): Map<string, StoredNotice> {
  const byKey = new Map<string, StoredNotice[]>();
  for (const stored of gone) {
    const key = pairKey(stored);
    byKey.set(key, [...(byKey.get(key) ?? []), stored]);
  }
  const pairs = new Map<string, StoredNotice>();
  for (const n of added) {
    const match = byKey.get(pairKey(n))?.shift();
    if (match !== undefined) pairs.set(n.sourceKey, match);
  }
  return pairs;
}

/** A notice of a file as stored, with the country its typed row gives. */
interface StoredNotice extends PairFields {
  id: number;
}

/**
 * Inserts typed rows or updates the ones whose values changed; returns the keys written and whether each was new. An
 * update that changes a row's `linkIdentity` also clears its `firm_id` and `link_score`.
 */
async function upsertTyped<TTable extends PgTable>(
  tx: Tx,
  table: TTable,
  keyColumn: PgColumn,
  values: PgInsertValue<TTable>[],
  linkIdentity: PgColumn[] | undefined,
): Promise<{ sourceKey: string; inserted: boolean }[]> {
  if (values.length === 0) return [];
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const updated = Object.keys(values[0]).filter((name) => columns[name] !== keyColumn);
  const excluded = (name: string): SQL => sql.raw(`excluded."${columns[name].name}"`);
  const set: Record<string, SQL> = Object.fromEntries(updated.map((name) => [name, excluded(name)]));
  if (linkIdentity !== undefined) {
    // Not compared in `setWhere`: a changed identity already is, as the typed row holds its columns.
    const identityChanged = sql`(${sql.join(linkIdentity, sql`, `)}) is distinct from (${sql.join(
      linkIdentity.map((column) => sql.raw(`excluded."${column.name}"`)),
      sql`, `,
    )})`;
    for (const name of ['firmId', 'linkScore']) set[name] = sql`case when ${identityChanged} then null else ${columns[name]} end`;
  }
  const setWhere = sql`(${sql.join(
    updated.map((name) => sql`${columns[name]}`),
    sql`, `,
  )}) is distinct from (${sql.join(updated.map(excluded), sql`, `)})`;
  return tx
    .insert(table)
    .values(values)
    .onConflictDoUpdate({ target: keyColumn, set: set as PgUpdateSetSource<TTable>, setWhere })
    .returning({ sourceKey: sql<string>`${keyColumn}`, inserted: sql<boolean>`(xmax = 0)` });
}

/**
 * Syncs a source published as one CSV per month in a CKAN package (P2-D5). Each file is downloaded and its SHA-256
 * compared with `source_file`; a file already loaded unchanged is skipped. A new or changed file has its rows upserted,
 * and the rows that same file (found through the notice URL) no longer holds are deleted with their notices; their
 * change events stay, without a notice. Everything is parsed first and written in one transaction, so a bad file or a
 * failed download leaves the live tables unchanged.
 *
 * A row key hashes the row's values, so a corrected row gets a new key. Inside a file loaded before, a new key whose
 * date, country (as the file writes it), product (and producer) match a key the file no longer holds is that row
 * corrected: the typed row, its notice (which keeps its id), its change events and, for a firm-level source, its match
 * reviews move to the new key in place, and no event is emitted. Every other new row emits an event; so does every row
 * of a file never loaded before.
 *
 * `rowsRead` counts the rows of the files loaded in this run; `rowsInserted`, `rowsUpdated` and `rowsDeleted` count
 * typed rows (a moved row counts as updated).
 */
export async function syncMonthlyFiles<R extends MonthlyRow, TTable extends PgTable>(
  deps: SyncDeps,
  spec: MonthlyFileSource<R, TTable>,
  options: { events: boolean },
): Promise<SyncRunResult> {
  return runSync(deps.db, spec.source, async (ctx) => {
    const emitEvents = await eventsForRun(deps.db, spec.source, options.events);
    ctx.setOrigin(spec.packageUrl);
    const resources = listMonthlyCsvResources((await deps.fetcher(spec.packageUrl, { expect: 'json' })).json());

    const changed: ChangedFile<R>[] = [];
    for (const resource of resources) {
      const file = await deps.fetcher(resource.url, { expect: 'csv' });
      const loaded = await loadedFile(deps.db, spec.source, resource.url);
      if (loaded?.sha256 === file.sha256) continue;
      let rows: R[];
      try {
        rows = spec.parse(file, resource);
      } catch (error) {
        throw new Error(`${resource.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
      changed.push({
        resource,
        sha256: file.sha256,
        loadedBefore: loaded !== null,
        rows: rows.map((row) => ({ ...row, ...spec.classify(deps.rules, row) })),
      });
    }
    ctx.counts.rowsRead = changed.reduce((sum, file) => sum + file.rows.length, 0);

    let rowsInserted = 0;
    let rowsUpdated = 0;
    let rowsDeleted = 0;
    let eventsEmitted = 0;

    await deps.db.transaction(async (tx) => {
      for (const { resource, sha256, loadedBefore, rows } of changed) {
        const notices = rows.map((row) => spec.notice(row, resource.url));

        // The rows this file held when it was last loaded. Its notices carry its URL, which ties them to this file.
        const stored: StoredNotice[] = await tx
          .select({
            id: notice.id,
            sourceKey: notice.sourceKey,
            noticeOn: notice.noticeOn,
            countryName: sql<string | null>`${spec.countryNameColumn}`,
            productText: notice.productText,
            firmName: notice.firmName,
          })
          .from(notice)
          .leftJoin(spec.table as PgTable, eq(spec.keyColumn, notice.sourceKey))
          .where(and(eq(notice.source, spec.source), eq(notice.url, resource.url)))
          .orderBy(notice.id);
        const present = new Set(rows.map((row) => row.sourceKey));
        const storedKeys = new Set(stored.map((s) => s.sourceKey));
        const gone = stored.filter((s) => !present.has(s.sourceKey));
        const corrections = loadedBefore
          ? pairCorrections(
              gone,
              notices.flatMap((n, i) => (storedKeys.has(n.sourceKey) ? [] : [{ ...n, countryName: rows[i].countryName }])),
            )
          : new Map<string, StoredNotice>();

        // Corrected rows move to their new key first, so the upserts below update them instead of inserting. Their change
        // events follow, and so do the match reviews of a firm-level source's records (the UK has none).
        for (const [newKey, old] of corrections) {
          await tx.execute(sql`update ${spec.table} set ${sql.identifier(spec.keyColumn.name)} = ${newKey} where ${spec.keyColumn} = ${old.sourceKey}`);
          await tx.update(notice).set({ sourceKey: newKey }).where(eq(notice.id, old.id));
          await tx.update(changeEvent).set({ sourceKey: newKey }).where(and(eq(changeEvent.source, spec.source), eq(changeEvent.sourceKey, old.sourceKey)));
          if (spec.linkIdentity !== undefined) {
            await tx.update(matchReview).set({ sourceKey: newKey }).where(and(eq(matchReview.source, spec.source), eq(matchReview.sourceKey, old.sourceKey)));
          }
        }

        const updatedKeys = new Set(corrections.keys());
        for (const batch of chunks(rows, BATCH_SIZE)) {
          for (const written of await upsertTyped(tx, spec.table, spec.keyColumn, batch.map((row) => spec.typedRow(row)), spec.linkIdentity)) {
            if (written.inserted) rowsInserted++;
            else updatedKeys.add(written.sourceKey);
          }
        }
        rowsUpdated += updatedKeys.size;

        const upserted = await upsertNotices(tx, notices);
        if (emitEvents) {
          const events: EventInput[] = [];
          for (const row of rows) {
            const created = upserted.get(row.sourceKey);
            if (created?.inserted) events.push(spec.event(row, created.id));
          }
          eventsEmitted += await insertEvents(tx, events);
        }

        const moved = new Set([...corrections.values()].map((s) => s.id));
        const deleted = gone.filter((s) => !moved.has(s.id));
        for (const part of chunks(deleted, KEY_CHUNK)) {
          const ids = part.map((s) => s.id);
          await tx.update(changeEvent).set({ noticeId: null }).where(inArray(changeEvent.noticeId, ids));
          await tx.delete(notice).where(inArray(notice.id, ids));
          await tx.delete(spec.table).where(inArray(spec.keyColumn, part.map((s) => s.sourceKey)));
        }
        rowsDeleted += deleted.length;

        await recordFile(tx, spec.source, resource.url, sha256, rows.length);
      }
    });

    ctx.counts.rowsInserted = rowsInserted;
    ctx.counts.rowsUpdated = rowsUpdated;
    ctx.counts.rowsDeleted = rowsDeleted;
    ctx.counts.eventsEmitted = eventsEmitted;
  });
}
