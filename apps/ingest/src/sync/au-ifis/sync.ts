import { auFailingFood } from '@rejectradar/db';
import type { SyncDeps } from '../../core/deps';
import { syncMonthlyFiles, type MonthlyFileSource } from '../../core/monthly-files';
import type { SyncRunResult } from '../../core/sync-run';
import { AU_PACKAGE_URL, classifyAu, decodeAuCsv, parseAuCsv, reasonsOf, type AuRecord } from './parse';

export { AU_PACKAGE_URL };

/** Titled by the first reason for fail: older files test for "Composition", the reason names the additive. */
const noticeTitle = (r: AuRecord): string => {
  const [first] = reasonsOf(r);
  return first === undefined ? `${r.productDesc} failed` : `${r.productDesc} failed: ${first}`;
};

/** A record without a date still has a notice date: the first day of its report month. */
const dateOf = (r: AuRecord): string => r.failedOn ?? r.reportMonth;

/**
 * Australian failing-food reports as a monthly-file source; a corrected record pairs on date, country, product and
 * producer.
 */
export const AU_FILES: MonthlyFileSource<AuRecord, typeof auFailingFood> = {
  source: 'au_ifis',
  packageUrl: AU_PACKAGE_URL,
  table: auFailingFood,
  keyColumn: auFailingFood.sourceKey,
  countryNameColumn: auFailingFood.countryName,
  linkIdentity: [auFailingFood.nameNorm, auFailingFood.countryCode],
  parse: (file, resource) => parseAuCsv(decodeAuCsv(file.bytes), `${resource.month}-01`),
  classify: classifyAu,
  typedRow: (r) => ({
    sourceKey: r.sourceKey,
    reportMonth: r.reportMonth,
    failedOn: r.failedOn,
    productDesc: r.productDesc,
    countryCode: r.countryCode,
    countryName: r.countryName,
    producerName: r.producerName,
    nameNorm: r.nameNorm,
    testApplied: r.testApplied,
    reason: r.reason,
    resultText: r.resultText,
    holdingOrderMatch: r.holdingOrderMatch,
    scheme: r.scheme,
    commodityId: r.commodityId,
    hazardIds: r.hazardIds,
  }),
  notice: (r, url) => ({
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
    url,
  }),
  event: (r, noticeId) => ({
    source: 'au_ifis',
    sourceKey: r.sourceKey,
    kind: 'au_failed_test',
    occurredOn: dateOf(r),
    // The linker skips a row whose normalised name is empty (a name with no Latin letters or digits), so only a linkable name can require a firm.
    requiresFirm: r.nameNorm !== '',
    originCountry: r.countryCode,
    commodityId: r.commodityId,
    hazardIds: r.hazardIds,
    noticeId,
  }),
};

/**
 * Syncs the Australian Imported Food Inspection Scheme failing-food reports: the CKAN package lists one CSV per month,
 * loaded by SHA-256 as described in {@link syncMonthlyFiles}.
 */
export async function syncAuIfis(deps: SyncDeps, options: { events: boolean }): Promise<SyncRunResult> {
  return syncMonthlyFiles(deps, AU_FILES, options);
}
