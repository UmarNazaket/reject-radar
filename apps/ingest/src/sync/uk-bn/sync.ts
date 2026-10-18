import { ukBorderNotification } from '@rejectradar/db';
import type { SyncDeps } from '../../core/deps';
import { syncMonthlyFiles, type MonthlyFileSource } from '../../core/monthly-files';
import type { SyncRunResult } from '../../core/sync-run';
import { classifyUk, parseUkCsv, UK_PACKAGE_URL, type UkRow } from './parse';

export { UK_PACKAGE_URL };

const noticeTitle = (r: UkRow): string =>
  `${r.productCategory ?? 'Unspecified product'}: ${r.hazardCategory ?? 'unspecified hazard'} (${r.originCountry ?? 'unknown origin'})`;

/** UK FSA border notifications as a monthly-file source; a corrected row pairs on date, country and product name. */
export const UK_FILES: MonthlyFileSource<UkRow, typeof ukBorderNotification> = {
  source: 'uk_bn',
  packageUrl: UK_PACKAGE_URL,
  table: ukBorderNotification,
  keyColumn: ukBorderNotification.sourceKey,
  parse: (file, resource) => parseUkCsv(file.text(), resource.month),
  classify: classifyUk,
  typedRow: (r) => ({
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
  }),
  notice: (r, url) => ({
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
    url,
  }),
  event: (r, noticeId) => ({
    source: 'uk_bn',
    sourceKey: r.sourceKey,
    kind: 'uk_border_notification',
    occurredOn: r.notifiedOn,
    requiresFirm: false,
    originCountry: r.originCountry,
    commodityId: r.commodityId,
    hazardIds: r.hazardIds,
    noticeId,
  }),
};

/**
 * Syncs the UK FSA border notifications: the CKAN package lists one CSV per month, loaded by SHA-256 as described in
 * {@link syncMonthlyFiles}.
 */
export async function syncUkBn(deps: SyncDeps, options: { events: boolean }): Promise<SyncRunResult> {
  return syncMonthlyFiles(deps, UK_FILES, options);
}
