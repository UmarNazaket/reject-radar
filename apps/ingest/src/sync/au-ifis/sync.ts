import { auFailingFood, changeEvent, notice } from '@rejectradar/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SyncDeps } from '../../core/deps';
import { insertEvents, upsertNotices, type EventInput, type NoticeInput } from '../../core/notices';
import { listMonthlyCsvResources, loadedFile, recordFile, type MonthlyResource } from '../../core/source-files';
import { eventsForRun, runSync, type SyncRunResult } from '../../core/sync-run';
import { AU_PACKAGE_URL, classifyAu, decodeAuCsv, parseAuCsv, testsOf, type AuRecord } from './parse';

export { AU_PACKAGE_URL };

const BATCH_SIZE = 500;
const KEY_CHUNK = 2000;

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

type ClassifiedRecord = AuRecord & { commodityId: number; hazardIds: number[] };

/** A monthly file that is new or changed since it was last loaded. */
interface ChangedFile {
  resource: MonthlyResource;
  sha256: string;
  records: ClassifiedRecord[];
}

const noticeTitle = (r: AuRecord): string => {
  const [first] = testsOf(r);
  return first === undefined ? `${r.productDesc} failed` : `${r.productDesc} failed: ${first}`;
};

/** A record without a date still has a notice date: the first day of its report month. */
const dateOf = (r: AuRecord): string => r.failedOn ?? r.reportMonth;

/**
 * Syncs the Australian Imported Food Inspection Scheme failing-food reports. The CKAN package lists one CSV per month;
 * each file is downloaded and its SHA-256 compared with `source_file`. A file already loaded unchanged is skipped. A new
 * or changed file has its records upserted, and the records of that same file (found through the notice URL) that it no
 * longer holds are deleted, with their notices; their change events stay, without a notice. Everything is parsed first
 * and written in one transaction, so a bad file or a failed download leaves the live tables unchanged. Events are
 * emitted for newly inserted records only.
 *
 * `rowsRead` counts the records of the files loaded in this run; `rowsInserted` and `rowsUpdated` count typed rows.
 */
export async function syncAuIfis(deps: SyncDeps, options: { events: boolean }): Promise<SyncRunResult> {
  return runSync(deps.db, 'au_ifis', async (ctx) => {
    const emitEvents = await eventsForRun(deps.db, 'au_ifis', options.events);
    ctx.setOrigin(AU_PACKAGE_URL);
    const resources = listMonthlyCsvResources((await deps.fetcher(AU_PACKAGE_URL, { expect: 'json' })).json());

    const changed: ChangedFile[] = [];
    for (const resource of resources) {
      const file = await deps.fetcher(resource.url, { expect: 'csv' });
      if ((await loadedFile(deps.db, 'au_ifis', resource.url))?.sha256 === file.sha256) continue;
      let records: AuRecord[];
      try {
        records = parseAuCsv(decodeAuCsv(file.bytes), `${resource.month}-01`);
      } catch (error) {
        throw new Error(`${resource.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
      changed.push({ resource, sha256: file.sha256, records: records.map((record) => ({ ...record, ...classifyAu(deps.rules, record) })) });
    }
    ctx.counts.rowsRead = changed.reduce((sum, file) => sum + file.records.length, 0);

    let rowsInserted = 0;
    let rowsUpdated = 0;
    let rowsDeleted = 0;
    let eventsEmitted = 0;

    await deps.db.transaction(async (tx) => {
      for (const { resource, sha256, records } of changed) {
        for (const batch of chunks(records, BATCH_SIZE)) {
          const returned = await tx
            .insert(auFailingFood)
            .values(
              batch.map((r) => ({
                sourceKey: r.sourceKey,
                reportMonth: r.reportMonth,
                failedOn: r.failedOn,
                productDesc: r.productDesc,
                countryCode: r.countryCode,
                producerName: r.producerName,
                nameNorm: r.nameNorm,
                testApplied: r.testApplied,
                reason: r.reason,
                resultText: r.resultText,
                holdingOrderMatch: r.holdingOrderMatch,
                scheme: r.scheme,
                commodityId: r.commodityId,
                hazardIds: r.hazardIds,
              })),
            )
            .onConflictDoUpdate({
              target: auFailingFood.sourceKey,
              set: {
                reportMonth: sql`excluded.report_month`,
                failedOn: sql`excluded.failed_on`,
                productDesc: sql`excluded.product_desc`,
                countryCode: sql`excluded.country_code`,
                producerName: sql`excluded.producer_name`,
                nameNorm: sql`excluded.name_norm`,
                testApplied: sql`excluded.test_applied`,
                reason: sql`excluded.reason`,
                resultText: sql`excluded.result_text`,
                holdingOrderMatch: sql`excluded.holding_order_match`,
                scheme: sql`excluded.scheme`,
                commodityId: sql`excluded.commodity_id`,
                hazardIds: sql`excluded.hazard_ids`,
              },
              setWhere: sql`(${auFailingFood.reportMonth}, ${auFailingFood.failedOn}, ${auFailingFood.productDesc}, ${auFailingFood.countryCode}, ${auFailingFood.producerName}, ${auFailingFood.nameNorm}, ${auFailingFood.testApplied}, ${auFailingFood.reason}, ${auFailingFood.resultText}, ${auFailingFood.holdingOrderMatch}, ${auFailingFood.scheme}, ${auFailingFood.commodityId}, ${auFailingFood.hazardIds})
                is distinct from
                (excluded.report_month, excluded.failed_on, excluded.product_desc, excluded.country_code, excluded.producer_name, excluded.name_norm, excluded.test_applied, excluded.reason, excluded.result_text, excluded.holding_order_match, excluded.scheme, excluded.commodity_id, excluded.hazard_ids)`,
            })
            .returning({ inserted: sql<boolean>`(xmax = 0)` });
          for (const r of returned) {
            if (r.inserted) rowsInserted++;
            else rowsUpdated++;
          }
        }

        const notices: NoticeInput[] = records.map((r) => ({
          source: 'au_ifis',
          sourceKey: r.sourceKey,
          noticeType: 'au_failed_test',
          noticeOn: dateOf(r),
          originCountry: r.countryCode,
          commodityId: r.commodityId,
          hazardIds: r.hazardIds,
          productText: r.productDesc,
          firmName: r.producerName,
          title: noticeTitle(r),
          url: resource.url,
        }));
        const upserted = await upsertNotices(tx, notices);

        if (emitEvents) {
          const events: EventInput[] = [];
          for (const r of records) {
            const created = upserted.get(r.sourceKey);
            if (!created?.inserted) continue;
            events.push({
              source: 'au_ifis',
              sourceKey: r.sourceKey,
              kind: 'au_failed_test',
              occurredOn: dateOf(r),
              requiresFirm: r.producerName !== null,
              originCountry: r.countryCode,
              commodityId: r.commodityId,
              hazardIds: r.hazardIds,
              noticeId: created.id,
            });
          }
          eventsEmitted += await insertEvents(tx, events);
        }

        // Records this file used to hold and no longer does. Its notices carry its URL, which ties them to this file.
        const present = new Set(records.map((r) => r.sourceKey));
        const stored = await tx
          .select({ id: notice.id, sourceKey: notice.sourceKey })
          .from(notice)
          .where(and(eq(notice.source, 'au_ifis'), eq(notice.url, resource.url)));
        const gone = stored.filter((s) => !present.has(s.sourceKey));
        for (const part of chunks(gone, KEY_CHUNK)) {
          const ids = part.map((s) => s.id);
          await tx.update(changeEvent).set({ noticeId: null }).where(inArray(changeEvent.noticeId, ids));
          await tx.delete(notice).where(inArray(notice.id, ids));
          await tx.delete(auFailingFood).where(inArray(auFailingFood.sourceKey, part.map((s) => s.sourceKey)));
        }
        rowsDeleted += gone.length;

        await recordFile(tx, 'au_ifis', resource.url, sha256, records.length);
      }
    });

    ctx.counts.rowsInserted = rowsInserted;
    ctx.counts.rowsUpdated = rowsUpdated;
    ctx.counts.rowsDeleted = rowsDeleted;
    ctx.counts.eventsEmitted = eventsEmitted;
  });
}
