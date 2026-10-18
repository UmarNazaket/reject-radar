import {
  auFailingFood,
  changeEvent,
  commodityRule,
  fdaChargeCode,
  fdaRefusal,
  hazardRule,
  importAlert,
  importAlertListing,
  importAlertListingProduct,
  notice,
  prepareTestDatabase,
  rasffNotification,
  sourceFile,
  sourceSyncRun,
  ukBorderNotification,
} from '@rejectradar/db';
import { and, count, eq, gt, ilike, sql } from 'drizzle-orm';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SyncDeps } from '../core/deps';
import { openDb } from '../core/db';
import { loadRuleSet } from '../core/rules';
import { fakeFetcher, fetchResult } from '../core/test-fetcher';
import { FDA_REFUSALS_URL } from '../verify/fda-api';
import { AU_PACKAGE_URL } from './au-ifis/parse';
import { syncAuIfis } from './au-ifis/sync';
import { FDA_CHARGE_CODES_URL, syncChargeCodes } from './fda/charge-codes';
import { syncFdaRefusals } from './fda/refusals';
import { IMPORT_ALERT_INDEX_URL, syncImportAlerts } from './import-alerts/sync';
import { RASFF_SEARCH_URL } from './rasff/parse';
import { syncRasff } from './rasff/sync';
import { remapTaxonomy } from './remap';
import { UK_HEADERS, UK_PACKAGE_URL } from './uk-bn/parse';
import { syncUkBn } from './uk-bn/sync';

const bytes = (source: string, name: string) => readFileSync(path.join(__dirname, source, '__fixtures__', name));
const text = (source: string, name: string) => bytes(source, name).toString('utf8');

const TODAY = '2026-10-18';
const AU_URLS = {
  'may-2026.csv': 'https://data.gov.au/data/dataset/e56bcf6a-7bfb-4cb5-8c65-8ec18bd4b7d5/resource/202d9e34-4e6d-4f6b-bacd-5731aa59e30d/download/may-2026-ifis-failing-food-report.csv',
  'june-2026.csv': 'https://data.gov.au/data/dataset/e56bcf6a-7bfb-4cb5-8c65-8ec18bd4b7d5/resource/b0950e17-c23b-4d8e-8122-4397459b4cec/download/failing-food-report-june-2026.csv',
  'july-2026.csv': 'https://data.gov.au/data/dataset/e56bcf6a-7bfb-4cb5-8c65-8ec18bd4b7d5/resource/a75154c8-1913-4a90-a498-ac78b02379c0/download/july-2026-ifis-failing-food-report.csv',
};
const UK_BASE = 'https://fsaopendata.blob.core.windows.net/opendatacatalog/';
const UK_DECEMBER_2024 = [UK_HEADERS.join(','), '05/12/2024,India,0910,100 kg,Herbs and spices,Turmeric Powder,Yes,FNAO,Mycotoxins,Mycotoxins,Physical', ''].join(String.fromCharCode(13, 10));

const IA_BASE = 'https://www.accessdata.fda.gov/cms_ia/';
const IA_ORIGINAL: Record<string, string> = {
  [`${IA_BASE}importalert_33.html`]: text('import-alerts', '16-131.html'),
  [`${IA_BASE}importalert_259.html`]: text('import-alerts', '99-08.html'),
  [`${IA_BASE}importalert_263.html`]: text('import-alerts', '99-19.html'),
};

/** The fixture index cut down to the three food alerts the pages above belong to. */
function smallIndex(): string {
  const html = text('import-alerts', 'ialist.html');
  const row = (number: string): string => {
    const match = new RegExp(`<tr>\\s*<td>${number}</td>[\\s\\S]*?</tr>`).exec(html);
    if (!match) throw new Error(`row ${number} missing from the fixture index`);
    return match[0];
  };
  return html.replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${['16-131', '99-08', '99-19'].map(row).join('\n')}</tbody>`);
}

const RASFF_PAGE = JSON.parse(text('rasff', 'search-page1.json')) as { notifications: Record<string, unknown>[] };
/** A page whose rows are all moved back so far that it ends the paging. */
const RASFF_OLD_PAGE = { ...RASFF_PAGE, notifications: RASFF_PAGE.notifications.map((n) => ({ ...n, ecValidationDate: '01-01-2026 10:00:00' })) };

describe('taxonomy remap', () => {
  let handle: ReturnType<typeof openDb>;
  let deps: SyncDeps;
  let failureDir: string;
  let ukFiles: Record<string, string | Buffer>;
  let iaPages: Record<string, string>;
  let firstCommodityRuleId: number;
  let firstHazardRuleId: number;

  /** Answers every outbound request of the five syncs from the committed fixtures. */
  const fetcher = () => {
    const ukPackage = text('uk-bn', 'package_show.json');
    const auPackage = text('au-ifis', 'package_show.json');
    return fakeFetcher((url) => {
      const json = (body: string) => fetchResult(body, { contentType: 'application/json', url });
      const csv = (body: string | Buffer) => fetchResult(body, { contentType: 'text/csv', url });
      if (url === FDA_CHARGE_CODES_URL) return csv(text('fda', 'charges.csv'));
      if (url === FDA_REFUSALS_URL) return json(text('fda', 'refusals-page1.json'));
      if (url === IMPORT_ALERT_INDEX_URL) return fetchResult(smallIndex(), { contentType: 'text/html', url });
      if (iaPages[url] !== undefined) return fetchResult(iaPages[url], { contentType: 'text/html', url });
      if (url === RASFF_SEARCH_URL) return json(JSON.stringify(RASFF_OLD_PAGE));
      if (url.includes('/view/id/')) return json(text('rasff', 'detail-880124.json'));
      if (url === UK_PACKAGE_URL) return json(ukPackage);
      if (url === AU_PACKAGE_URL) return json(auPackage);
      const au = Object.entries(AU_URLS).find(([, au]) => au === url);
      if (au) return csv(bytes('au-ifis', au[0]));
      if (ukFiles[url] !== undefined) return csv(ukFiles[url]);
      throw new Error(`unexpected request ${url}`);
    });
  };

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_remap'));
    firstCommodityRuleId = (await handle.db.select({ n: sql<number>`coalesce(max(${commodityRule.id}), 0)` }).from(commodityRule))[0].n;
    firstHazardRuleId = (await handle.db.select({ n: sql<number>`coalesce(max(${hazardRule.id}), 0)` }).from(hazardRule))[0].n;
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const table of [changeEvent, notice, fdaRefusal, fdaChargeCode, importAlert, rasffNotification, ukBorderNotification, auFailingFood, sourceFile, sourceSyncRun]) {
      await handle.db.delete(table);
    }
    iaPages = { ...IA_ORIGINAL };
    failureDir = mkdtempSync(path.join(tmpdir(), 'remap-failures-'));
    ukFiles = {
      [`${UK_BASE}April-2026.csv`]: bytes('uk-bn', 'April-2026.csv'),
      [`${UK_BASE}BNApril2025.csv`]: bytes('uk-bn', 'BNApril2025.csv'),
      [`${UK_BASE}BNDecember2024.csv`]: UK_DECEMBER_2024,
    };
    deps = { db: handle.db, rules: await loadRuleSet(handle.db), today: () => TODAY, fetcher: fetcher().fetcher };
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await handle.db.delete(commodityRule).where(gt(commodityRule.id, firstCommodityRuleId));
    await handle.db.delete(hazardRule).where(gt(hazardRule.id, firstHazardRuleId));
  });

  const total = async (table: typeof notice | typeof changeEvent | typeof sourceSyncRun) => Number((await handle.db.select({ n: count() }).from(table))[0].n);
  const zero = { fda_charge_code: 0, fda_refusal: 0, import_alert: 0, rasff: 0, uk_bn: 0, au_ifis: 0 };

  const loadAll = async (events: boolean) => {
    await syncChargeCodes(deps);
    await syncFdaRefusals({ ...deps, creds: { user: 'u', key: 'k' } }, { from: '2026-09-01', to: '2026-09-30', events });
    await syncImportAlerts({ ...deps, failureDir }, { events });
    await syncRasff(deps, { detailsLimit: 200, events });
    await syncUkBn(deps, { events });
    await syncAuIfis(deps, { events });
  };

  it('re-applies a new rule to the Australian row and its notice without touching events or runs', async () => {
    await syncAuIfis(deps, { events: true });
    const events = await total(changeEvent);
    const runs = await total(sourceSyncRun);
    expect(events).toBe(97);
    const before = await handle.db.select().from(auFailingFood).where(eq(auFailingFood.productDesc, 'Throat drops'));
    expect(before).toHaveLength(1);
    expect(before[0].commodityId).not.toBe(1300);

    await handle.db.insert(commodityRule).values({ source: 'au_ifis', field: 'product_desc', matchType: 'keyword', pattern: 'throat drops', commodityId: 1300, priority: 1 });
    const result = await remapTaxonomy(handle.db);

    expect(result.updated).toEqual({ ...zero, au_ifis: 1 });
    const [row] = await handle.db.select().from(auFailingFood).where(eq(auFailingFood.productDesc, 'Throat drops'));
    expect(row.commodityId).toBe(1300);
    const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, row.sourceKey));
    expect(n.commodityId).toBe(1300);
    expect(await total(changeEvent)).toBe(events);
    expect(await total(sourceSyncRun)).toBe(runs);

    expect((await remapTaxonomy(handle.db)).updated).toEqual(zero);
  });

  it('reports 0 updates on freshly synced data of every source', async () => {
    await loadAll(false);
    for (const table of [fdaRefusal, importAlertListing, rasffNotification, ukBorderNotification, auFailingFood]) {
      expect(Number((await handle.db.select({ n: count() }).from(table))[0].n)).toBeGreaterThan(0);
    }
    expect((await handle.db.select().from(rasffNotification).where(sql`jsonb_array_length(${rasffNotification.hazards}) > 0`)).length).toBeGreaterThan(0);

    expect((await remapTaxonomy(handle.db)).updated).toEqual(zero);
  });

  it('recomputes charge-code hazards first, then the refusals and notices that use them', async () => {
    await syncChargeCodes(deps);
    await syncFdaRefusals({ ...deps, creds: { user: 'u', key: 'k' } }, { from: '2026-09-01', to: '2026-09-30', events: false });
    const salmonella = (await handle.db.select().from(fdaChargeCode).where(eq(fdaChargeCode.name, 'SALMONELLA')))[0];
    expect(salmonella.hazardId).toBe(400);
    const using = (await handle.db.select().from(fdaRefusal)).filter((r) => r.chargeCodes.includes(salmonella.code));
    expect(using.length).toBeGreaterThan(0);

    await handle.db.insert(hazardRule).values({ source: 'fda_charge_code', field: 'code', matchType: 'exact', pattern: 'SALMONELLA', hazardId: 100, priority: 1 });
    const result = await remapTaxonomy(handle.db);

    expect(result.updated.fda_charge_code).toBe(1);
    expect(result.updated.fda_refusal).toBeGreaterThanOrEqual(using.length);
    expect((await handle.db.select().from(fdaChargeCode).where(eq(fdaChargeCode.code, salmonella.code)))[0].hazardId).toBe(100);
    for (const r of using) {
      const [after] = await handle.db.select().from(fdaRefusal).where(eq(fdaRefusal.sourceKey, r.sourceKey));
      expect(after.hazardIds).toContain(100);
      expect(after.hazardIds).not.toContain(400);
      const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, r.sourceKey));
      expect(n.hazardIds).toEqual(after.hazardIds);
    }
    expect((await remapTaxonomy(handle.db)).updated).toEqual(zero);
  });

  it('re-applies a rule to Import Alert listings from their current products and their red notices', async () => {
    await syncImportAlerts({ ...deps, failureDir }, { events: false });
    const fenugreek = await handle.db.select().from(notice).where(ilike(notice.productText, '%fenugreek%'));
    expect(fenugreek.length).toBeGreaterThan(0);
    expect(fenugreek.every((n) => n.commodityId !== 1300)).toBe(true);

    await handle.db.insert(commodityRule).values({ source: 'import_alert', field: 'product_name', matchType: 'keyword', pattern: 'fenugreek', commodityId: 1300, priority: 1 });
    const result = await remapTaxonomy(handle.db);

    expect(result.updated.import_alert).toBeGreaterThanOrEqual(fenugreek.length);
    const after = await handle.db.select().from(notice).where(ilike(notice.productText, '%fenugreek%'));
    expect(after.every((n) => n.commodityId === 1300)).toBe(true);
    expect(result.updated).toEqual({ ...zero, import_alert: result.updated.import_alert });
    expect((await remapTaxonomy(handle.db)).updated).toEqual(zero);
  });

  it('reads problems from the stored column, not from the cut-off notes', async () => {
    const withSalmonella = () =>
      handle.db
        .select({ key: importAlertListing.listingKey })
        .from(importAlertListingProduct)
        .innerJoin(importAlertListing, eq(importAlertListing.id, importAlertListingProduct.listingId))
        .where(and(eq(importAlertListing.list, 'red'), sql`'SALMONELLA' = any(${importAlertListingProduct.problems})`));
    await syncImportAlerts({ ...deps, failureDir }, { events: false });
    const keys = [...new Set((await withSalmonella()).map((r) => r.key))];
    expect(keys.length).toBeGreaterThan(0);

    await handle.db.insert(hazardRule).values({ source: 'import_alert', field: 'problem', matchType: 'exact', pattern: 'SALMONELLA', hazardId: 700, priority: 1 });
    expect((await handle.db.select().from(notice).where(eq(notice.source, 'import_alert'))).some((n) => n.hazardIds.includes(700))).toBe(false);
    const result = await remapTaxonomy(handle.db);

    expect(result.updated.import_alert).toBeGreaterThan(0);
    const notices = await handle.db.select().from(notice).where(eq(notice.source, 'import_alert'));
    for (const n of notices) expect(n.hazardIds.includes(700)).toBe(keys.includes(n.sourceKey));
    expect((await remapTaxonomy(handle.db)).updated).toEqual(zero);
  });

  /** The first firm's block of alert 99-19: five products, the first of them 24 T (industry code 24). */
  const PAGE_99_19 = `${IA_BASE}importalert_263.html`;
  const firstBlock = () => {
    const block = /<div class="div-info">[\s\S]*?(?=\s*<hr\/>\s*<div class="center"><h4>ALBANIA)/.exec(IA_ORIGINAL[PAGE_99_19])?.[0];
    expect(block).toBeTruthy();
    return block as string;
  };
  const vegetables = () => {
    const product = /\s*<div>\s*<div class="floatleft"><em>24&nbsp;T&nbsp;-&nbsp;-&nbsp;99 <\/em>[\s\S]*?<\/p>/.exec(firstBlock())?.[0];
    expect(product).toBeTruthy();
    return product as string;
  };
  const withBlock = (block: string) => IA_ORIGINAL[PAGE_99_19].replace(firstBlock(), block);

  it('keeps a problem that lies past the 1,000-character cut of the notes', async () => {
    const long = vegetables().replace('</p>', `<div>Notes: ${'x'.repeat(1100)}</div><div class="small">Problems: ${'y'.repeat(50)}; LISTERIA;</div></p>`);
    iaPages[PAGE_99_19] = withBlock(firstBlock().replace(vegetables(), long));

    await syncImportAlerts({ ...deps, failureDir }, { events: false });
    const [product] = await handle.db.select().from(importAlertListingProduct).where(sql`'LISTERIA' = any(${importAlertListingProduct.problems})`);
    expect(product.notes).toHaveLength(1000);
    expect(product.notes).not.toContain('LISTERIA');
    const [listing] = await handle.db.select().from(importAlertListing).where(eq(importAlertListing.id, product.listingId));
    const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, listing.listingKey));
    expect(n.hazardIds).toContain(401);

    expect((await remapTaxonomy(handle.db)).updated).toEqual(zero);
    const [after] = await handle.db.select().from(notice).where(eq(notice.sourceKey, listing.listingKey));
    expect(after.hazardIds).toEqual(n.hazardIds);
  });

  it('uses the page order of products, also for one that reappeared with an old low id', async () => {
    const without = firstBlock().replace(vegetables(), '');
    const lastEnd = without.lastIndexOf('</p>') + '</p>'.length;
    const moved = `${without.slice(0, lastEnd)}${vegetables()}${without.slice(lastEnd)}`;
    expect(moved).not.toBe(firstBlock());

    // Only a listing whose first product has industry code 24 gets this commodity, so a wrong "first product" shows.
    await handle.db.insert(commodityRule).values({ source: 'import_alert', field: 'industry_code', matchType: 'exact', pattern: '24', commodityId: 1300, priority: 1 });
    deps = { ...deps, rules: await loadRuleSet(handle.db) };

    await syncImportAlerts({ ...deps, failureDir }, { events: false });
    iaPages[PAGE_99_19] = withBlock(without);
    await syncImportAlerts({ ...deps, failureDir }, { events: false });
    iaPages[PAGE_99_19] = withBlock(moved);
    await syncImportAlerts({ ...deps, failureDir }, { events: false });

    const [product] = await handle.db.select().from(importAlertListingProduct).where(eq(importAlertListingProduct.productCode, '24T--99'));
    expect(product.removedOn).toBeNull();
    expect(product.position).toBe(4);
    const others = await handle.db.select().from(importAlertListingProduct).where(and(eq(importAlertListingProduct.listingId, product.listingId), sql`${importAlertListingProduct.id} > ${product.id}`));
    expect(others.length).toBeGreaterThan(0);
    const [listing] = await handle.db.select().from(importAlertListing).where(eq(importAlertListing.id, product.listingId));
    const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, listing.listingKey));
    expect(n.commodityId).not.toBe(1300);

    expect((await remapTaxonomy(handle.db)).updated).toEqual(zero);
  });

  it('gives the same result whatever the batch size', async () => {
    await loadAll(false);
    await handle.db.insert(commodityRule).values([
      { source: 'au_ifis', field: 'product_desc', matchType: 'keyword', pattern: 'cheese', commodityId: 1300, priority: 1 },
      { source: 'uk_bn', field: 'product_name', matchType: 'keyword', pattern: 'powder', commodityId: 1300, priority: 1 },
      { source: 'rasff', field: 'subject', matchType: 'keyword', pattern: 'salmonella', commodityId: 1300, priority: 1 },
      { source: 'fda_refusal', field: 'product_desc', matchType: 'keyword', pattern: 'bread', commodityId: 1300, priority: 1 },
    ]);
    const result = await remapTaxonomy(handle.db, { batchSize: 7 });
    expect(Object.values(result.updated).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect((await remapTaxonomy(handle.db)).updated).toEqual(zero);
    expect((await remapTaxonomy(handle.db, { batchSize: 3 })).updated).toEqual(zero);
  });
});
