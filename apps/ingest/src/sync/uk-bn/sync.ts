import { changeEvent, notice, ukBorderNotification } from '@rejectradar/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SyncDeps } from '../../core/deps';
import { insertEvents, upsertNotices, type EventInput, type NoticeInput } from '../../core/notices';
import { listMonthlyCsvResources, loadedFile, recordFile, type MonthlyResource } from '../../core/source-files';
import { runSync, type SyncRunResult } from '../../core/sync-run';
import { classifyUk, parseUkCsv, UK_PACKAGE_URL, type UkRow } from './parse';

export { UK_PACKAGE_URL };

const BATCH_SIZE = 500;
const KEY_CHUNK = 2000;

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

type ClassifiedRow = UkRow & { commodityId: number; hazardIds: number[] };

/** A monthly file that is new or changed since it was last loaded. */
interface ChangedFile {
  resource: MonthlyResource;
  sha256: string;
  rows: ClassifiedRow[];
}

const noticeTitle = (r: UkRow): string =>
  `${r.productCategory ?? 'Unspecified product'}: ${r.hazardCategory ?? 'unspecified hazard'} (${r.originCountry ?? 'unknown origin'})`;

/**
 * Syncs the UK FSA border notifications. The CKAN package lists one CSV per month; each file is downloaded and its
 * SHA-256 compared with `source_file`. A file already loaded unchanged is skipped. A new or changed file has its rows
 * upserted, and the rows of that same file (found through the notice URL) that it no longer holds are deleted, with
 * their notices; their change events stay, without a notice. Everything is parsed first and written in one transaction,
 * so a bad file leaves the live tables unchanged. Events are emitted for newly inserted rows only.
 *
 * `rowsRead` counts the rows of the files loaded in this run; `rowsInserted` and `rowsUpdated` count typed rows.
 */
export async function syncUkBn(deps: SyncDeps, options: { events: boolean }): Promise<SyncRunResult> {
  return runSync(deps.db, 'uk_bn', async (ctx) => {
    ctx.setOrigin(UK_PACKAGE_URL);
    const resources = listMonthlyCsvResources((await deps.fetcher(UK_PACKAGE_URL, { expect: 'json' })).json());

    const changed: ChangedFile[] = [];
    for (const resource of resources) {
      const file = await deps.fetcher(resource.url, { expect: 'csv' });
      if ((await loadedFile(deps.db, 'uk_bn', resource.url))?.sha256 === file.sha256) continue;
      let rows: UkRow[];
      try {
        rows = parseUkCsv(file.text(), resource.month);
      } catch (error) {
        throw new Error(`${resource.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
      changed.push({ resource, sha256: file.sha256, rows: rows.map((row) => ({ ...row, ...classifyUk(deps.rules, row) })) });
    }
    ctx.counts.rowsRead = changed.reduce((sum, file) => sum + file.rows.length, 0);

    let rowsInserted = 0;
    let rowsUpdated = 0;
    let rowsDeleted = 0;
    let eventsEmitted = 0;

    await deps.db.transaction(async (tx) => {
      for (const { resource, sha256, rows } of changed) {
        for (const batch of chunks(rows, BATCH_SIZE)) {
          const returned = await tx
            .insert(ukBorderNotification)
            .values(
              batch.map((r) => ({
                sourceKey: r.sourceKey,
                notifiedOn: r.notifiedOn,
                originCountry: r.originCountry,
                commodity: r.commodity,
                productCategory: r.productCategory,
                productName: r.productName,
                hazardCategory: r.hazardCategory,
                failureType: r.failureType,
                reason: r.reason,
                consignmentType: r.consignmentType,
                legislationControlled: r.legislationControlled,
                commodityId: r.commodityId,
                hazardIds: r.hazardIds,
              })),
            )
            .onConflictDoUpdate({
              target: ukBorderNotification.sourceKey,
              set: {
                notifiedOn: sql`excluded.notified_on`,
                originCountry: sql`excluded.origin_country`,
                commodity: sql`excluded.commodity`,
                productCategory: sql`excluded.product_category`,
                productName: sql`excluded.product_name`,
                hazardCategory: sql`excluded.hazard_category`,
                failureType: sql`excluded.failure_type`,
                reason: sql`excluded.reason`,
                consignmentType: sql`excluded.consignment_type`,
                legislationControlled: sql`excluded.legislation_controlled`,
                commodityId: sql`excluded.commodity_id`,
                hazardIds: sql`excluded.hazard_ids`,
              },
              setWhere: sql`(${ukBorderNotification.notifiedOn}, ${ukBorderNotification.originCountry}, ${ukBorderNotification.commodity}, ${ukBorderNotification.productCategory}, ${ukBorderNotification.productName}, ${ukBorderNotification.hazardCategory}, ${ukBorderNotification.failureType}, ${ukBorderNotification.reason}, ${ukBorderNotification.consignmentType}, ${ukBorderNotification.legislationControlled}, ${ukBorderNotification.commodityId}, ${ukBorderNotification.hazardIds})
                is distinct from
                (excluded.notified_on, excluded.origin_country, excluded.commodity, excluded.product_category, excluded.product_name, excluded.hazard_category, excluded.failure_type, excluded.reason, excluded.consignment_type, excluded.legislation_controlled, excluded.commodity_id, excluded.hazard_ids)`,
            })
            .returning({ inserted: sql<boolean>`(xmax = 0)` });
          for (const r of returned) {
            if (r.inserted) rowsInserted++;
            else rowsUpdated++;
          }
        }

        const notices: NoticeInput[] = rows.map((r) => ({
          source: 'uk_bn',
          sourceKey: r.sourceKey,
          noticeType: 'uk_border_notification',
          noticeOn: r.notifiedOn,
          originCountry: r.originCountry,
          commodityId: r.commodityId,
          hazardIds: r.hazardIds,
          productText: r.productName,
          firmName: null,
          title: noticeTitle(r),
          url: resource.url,
        }));
        const upserted = await upsertNotices(tx, notices);

        if (options.events) {
          const events: EventInput[] = [];
          for (const r of rows) {
            const created = upserted.get(r.sourceKey);
            if (!created?.inserted) continue;
            events.push({
              source: 'uk_bn',
              sourceKey: r.sourceKey,
              kind: 'uk_border_notification',
              occurredOn: r.notifiedOn,
              requiresFirm: false,
              originCountry: r.originCountry,
              commodityId: r.commodityId,
              hazardIds: r.hazardIds,
              noticeId: created.id,
            });
          }
          eventsEmitted += await insertEvents(tx, events);
        }

        // Rows this file used to hold and no longer does. Its notices carry its URL, which ties them to this file.
        const present = new Set(rows.map((r) => r.sourceKey));
        const stored = await tx
          .select({ id: notice.id, sourceKey: notice.sourceKey })
          .from(notice)
          .where(and(eq(notice.source, 'uk_bn'), eq(notice.url, resource.url)));
        const gone = stored.filter((s) => !present.has(s.sourceKey));
        for (const part of chunks(gone, KEY_CHUNK)) {
          const ids = part.map((s) => s.id);
          await tx.update(changeEvent).set({ noticeId: null }).where(inArray(changeEvent.noticeId, ids));
          await tx.delete(notice).where(inArray(notice.id, ids));
          await tx.delete(ukBorderNotification).where(inArray(ukBorderNotification.sourceKey, part.map((s) => s.sourceKey)));
        }
        rowsDeleted += gone.length;

        await recordFile(tx, 'uk_bn', resource.url, sha256, rows.length);
      }
    });

    ctx.counts.rowsInserted = rowsInserted;
    ctx.counts.rowsUpdated = rowsUpdated;
    ctx.counts.rowsDeleted = rowsDeleted;
    ctx.counts.eventsEmitted = eventsEmitted;
  });
}
