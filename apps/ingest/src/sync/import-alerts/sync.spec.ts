import { changeEvent, importAlert, importAlertListing, importAlertListingProduct, matchReview, notice, prepareTestDatabase, sourceSyncRun } from '@rejectradar/db';
import { insertEvent, insertFirm } from '@rejectradar/entities';
import { count, desc, eq, inArray } from 'drizzle-orm';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SyncDeps } from '../../core/deps';
import { openDb } from '../../core/db';
import { loadRuleSet } from '../../core/rules';
import { fakeFetcher, fetchResult } from '../../core/test-fetcher';
import { seedSucceededRun } from '../../core/test-sync-run';
import { parseAlertPage, type ParsedListing } from './parse-page';
import { classifyListing, IMPORT_ALERT_INDEX_URL, listingKey, syncImportAlerts } from './sync';

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const TODAY = '2026-10-18';
/** Inside FDA's robots.txt visiting hours (03:00-09:00 UTC), when an Import Alert crawl may start. */
const VISITING_HOUR = () => new Date(`${TODAY}T05:00:00Z`);
const BASE = 'https://www.accessdata.fda.gov/cms_ia/';
const URLS = {
  '16-131': `${BASE}importalert_33.html`,
  '99-08': `${BASE}importalert_259.html`,
  '99-19': `${BASE}importalert_263.html`,
};
const DRUG_URL = `${BASE}importalert_999.html`;

/** The fixture index cut down to three food alerts and one drug alert. */
function smallIndex(): string {
  const html = fixture('ialist.html');
  const row = (number: string): string => {
    const match = new RegExp(`<tr>\\s*<td>${number}</td>[\\s\\S]*?</tr>`).exec(html);
    if (!match) throw new Error(`row ${number} missing from the fixture index`);
    return match[0];
  };
  const drug = row('66-40').replace(/href="[^"]*"/, `href="importalert_999.html"`);
  const rows = ['16-131', '99-08', '99-19'].map(row).join('\n') + '\n' + drug;
  return html.replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${rows}</tbody>`);
}

const INDEX = smallIndex();
const ORIGINAL: Record<keyof typeof URLS, string> = {
  '16-131': fixture('16-131.html'),
  '99-08': fixture('99-08.html'),
  '99-19': fixture('99-19.html'),
};

/** Drops the first firm block (and its products) of 99-19, up to the next country heading. */
const withoutFirstFirm = (html: string): string => {
  const cut = html.replace(/<div class="div-info">[\s\S]*?(?=\s*<hr\/>\s*<div class="center"><h4>ALBANIA)/, '');
  expect(cut).not.toBe(html);
  return cut;
};

/** Drops the 28A--56 product of the first firm. */
const withoutFenugreek = (html: string): string => {
  const cut = html.replace(/\s*<div>\s*<div class="floatleft"><em>28&nbsp;A&nbsp;-&nbsp;-&nbsp;56 <\/em>[\s\S]*?<\/p>/, '');
  expect(cut).not.toBe(html);
  return cut;
};

/** Turns the last country section of the page into a Green List section. */
const lastSectionGreen = (html: string): string => {
  const at = Math.max(...[...html.matchAll(/<hr\/>\s*<div class="center"><h4>/g)].map((m) => m.index ?? -1));
  expect(at).toBeGreaterThan(0);
  return `${html.slice(0, at)}<hr/><div class="center"><a name="GreenFirm"></a><h4>Green List</h4></div>${html.slice(at)}`;
};

describe('Import Alert sync', () => {
  let handle: ReturnType<typeof openDb>;
  let deps: SyncDeps;
  let failureDir: string;
  let pages: Record<string, string>;
  let index: string;
  let requested: string[];

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_ia'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.delete(matchReview);
    await handle.db.delete(changeEvent);
    await handle.db.delete(notice);
    await handle.db.delete(importAlert);
    await handle.db.delete(sourceSyncRun);
    // Not a first load, unless a test deletes this run: events are emitted as asked.
    await seedSucceededRun(handle.db, 'import_alerts');
    const rules = await loadRuleSet(handle.db);
    const fake = fakeFetcher((url, options) => {
      requested.push(url);
      expect(options?.expect).toBe('html');
      const body = url === IMPORT_ALERT_INDEX_URL ? index : pages[url];
      if (body === undefined) throw new Error(`unexpected request ${url}`);
      return fetchResult(body, { contentType: 'text/html', url });
    });
    deps = { db: handle.db, rules, today: () => TODAY, fetcher: fake.fetcher };
    failureDir = mkdtempSync(path.join(tmpdir(), 'ia-failures-'));
    index = INDEX;
    requested = [];
    pages = {
      [URLS['16-131']]: ORIGINAL['16-131'],
      [URLS['99-08']]: ORIGINAL['99-08'],
      [URLS['99-19']]: ORIGINAL['99-19'],
    };
  });

  const run = (options: { events?: boolean; only?: string[] } = {}) =>
    syncImportAlerts({ ...deps, failureDir, now: VISITING_HOUR }, { events: options.events ?? true, only: options.only });
  const serve = (number: keyof typeof URLS, html: string) => {
    pages[URLS[number]] = html;
  };
  const total = async (table: typeof notice | typeof changeEvent | typeof importAlertListing | typeof importAlertListingProduct | typeof importAlert) =>
    Number((await handle.db.select({ n: count() }).from(table))[0].n);
  const listings = () => handle.db.select().from(importAlertListing);
  const events = () => handle.db.select().from(changeEvent).orderBy(changeEvent.id);
  const lastRun = async () => (await handle.db.select().from(sourceSyncRun).orderBy(desc(sourceSyncRun.id)).limit(1))[0];
  const parsed = (number: keyof typeof URLS, html = ORIGINAL[number]) => parseAlertPage(html, URLS[number]);
  const keyOf = (number: string, l: Parameters<typeof listingKey>[1]) => listingKey(number, l);

  describe('listingKey and classifyListing', () => {
    const alert = parsed('99-19');
    const first = alert.listings[0];

    it('is a stable 40-character hash that depends on alert, firm, country and address', () => {
      const key = listingKey('99-19', first);
      expect(key).toMatch(/^[0-9a-f]{40}$/);
      expect(listingKey('99-19', { ...first })).toBe(key);
      expect(listingKey('99-08', first)).not.toBe(key);
      expect(listingKey('99-19', { ...first, firmName: 'Someone Else Ltd' })).not.toBe(key);
      expect(listingKey('99-19', { ...first, countryName: 'Elsewhere' })).not.toBe(key);
      expect(listingKey('99-19', { ...first, addressRaw: '1 Other Road' })).not.toBe(key);
      expect(listingKey('99-19', { ...first, firmName: first.firmName.toUpperCase() })).toBe(key);
    });

    it('does not depend on the country code or the matching normalisers', () => {
      const key = listingKey('99-19', first);
      // A heading normalizeCountry does not know today (null) and maps after a later alias is added (or maps differently).
      expect(listingKey('99-19', { ...first, countryCode: null })).toBe(key);
      expect(listingKey('99-19', { ...first, countryCode: 'ZZ' })).toBe(key);
      // Only the raw text counts, after accents, case and punctuation are dropped.
      expect(listingKey('99-19', { ...first, firmName: `  ${first.firmName.toLowerCase()}. ` })).toBe(key);
      expect(listingKey('99-19', { ...first, countryName: first.countryName.toLowerCase() })).toBe(key);
    });

    it('classifies from the first product and the alert title', async () => {
      const rules = await loadRuleSet(handle.db);
      const result = classifyListing(rules, alert, first);
      expect(Number.isInteger(result.commodityId)).toBe(true);
      expect(result.hazardIds.length).toBeGreaterThan(0);
      const noProducts = classifyListing(rules, { title: 'Salmonella' }, { ...first, products: [] });
      expect(noProducts.hazardIds.length).toBeGreaterThan(0);
    });
  });

  it('loads alerts, listings and products', async () => {
    const result = await run();
    const alerts = (['16-131', '99-08', '99-19'] as const).map((n) => parsed(n));
    const expected = new Map(alerts.flatMap((a) => a.listings.map((l) => [keyOf(a.number, l), l] as const)));

    expect(requested).toEqual([IMPORT_ALERT_INDEX_URL, URLS['16-131'], URLS['99-08'], URLS['99-19']]);
    expect(requested).not.toContain(DRUG_URL);
    const stored = await handle.db.select().from(importAlert);
    expect(stored.map((a) => a.number).sort()).toEqual(['16-131', '99-08', '99-19']);
    expect(stored.every((a) => a.isFood && a.removedAt === null && a.lastSeenAt !== null)).toBe(true);
    const a1919 = stored.find((a) => a.number === '99-19');
    expect(a1919).toMatchObject({ textSha256: alerts[2].textSha256, url: URLS['99-19'], title: alerts[2].title });

    const rows = await listings();
    expect(rows).toHaveLength(expected.size);
    expect(rows.every((r) => r.firstSeenOn === TODAY && r.lastSeenOn === TODAY && r.missedRuns === 0 && r.removedOn === null)).toBe(true);
    expect(rows.filter((r) => r.list === 'green')).toHaveLength(alerts[0].listings.length);

    const productCount = [...expected.values()].reduce((sum, l) => sum + l.products.length, 0);
    expect(await total(importAlertListingProduct)).toBe(productCount);

    const red = [...expected.entries()].filter(([, l]) => l.list === 'red');
    expect(red.length).toBeGreaterThan(0);
    const notices = await handle.db.select().from(notice);
    expect(notices).toHaveLength(red.length);
    expect(notices.every((n) => n.source === 'import_alert' && n.noticeType === 'import_alert_listing' && n.destination === 'US')).toBe(true);
    const sample = notices.find((n) => n.sourceKey === keyOf('99-19', alerts[2].listings[0]));
    expect(sample).toMatchObject({
      title: `${alerts[2].listings[0].firmName} on Import Alert 99-19`,
      url: URLS['99-19'],
      firmName: alerts[2].listings[0].firmName,
      noticeOn: alerts[2].listings[0].listedOn,
    });

    const evs = await events();
    expect(evs).toHaveLength(red.length);
    expect(evs.every((e) => e.kind === 'import_alert_listed' && e.requiresFirm && e.source === 'import_alert' && e.noticeId !== null)).toBe(true);
    const greenKeys = new Set([...expected.entries()].filter(([, l]) => l.list === 'green').map(([k]) => k));
    expect(evs.some((e) => greenKeys.has(e.sourceKey))).toBe(false);
    expect(await total(notice)).toBe(red.length);
    expect(result).toMatchObject({ status: 'succeeded', rowsRead: expected.size, rowsInserted: expected.size, rowsUpdated: 0, eventsEmitted: red.length });
    expect((await lastRun()).status).toBe('succeeded');
  });

  it('suppresses events on a first load, then emits them', async () => {
    await handle.db.delete(sourceSyncRun);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      serve('99-19', withoutFirstFirm(ORIGINAL['99-19']));
      const first = await run();
      expect(first).toMatchObject({ status: 'succeeded', eventsEmitted: 0 });
      expect(first.rowsInserted).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledWith('first load of import_alerts: events suppressed');
      expect(await total(changeEvent)).toBe(0);
      serve('99-19', ORIGINAL['99-19']);
      const second = await run();
      expect(second).toMatchObject({ rowsInserted: 1, eventsEmitted: 1 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not count a run limited by --only as the first load', async () => {
    await handle.db.delete(sourceSyncRun);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const partial = await run({ only: ['99-19'] });
      expect(partial).toMatchObject({ status: 'succeeded', eventsEmitted: 0 });
      expect(await lastRun()).toMatchObject({ status: 'succeeded', partial: true });
      const full = await run();
      expect(full.rowsInserted).toBeGreaterThan(0);
      expect(full.eventsEmitted).toBe(0);
      expect(await total(changeEvent)).toBe(0);
      expect(await lastRun()).toMatchObject({ status: 'succeeded', partial: false });
      expect(warn.mock.calls.filter(([message]) => message === 'first load of import_alerts: events suppressed')).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  describe('visiting hours (03:00-09:00 UTC)', () => {
    const at = (iso: string) => () => new Date(iso);
    const runAt = (iso: string, options: { only?: string[]; forceHours?: boolean } = {}) =>
      syncImportAlerts({ ...deps, failureDir, now: at(iso) }, { events: true, ...options });

    it('refuses a full crawl outside them, before any request or run row', async () => {
      for (const iso of ['2026-10-18T02:59:59Z', '2026-10-18T09:00:00Z', '2026-10-18T15:30:00Z']) {
        await expect(runAt(iso)).rejects.toThrow(/03:00-09:00 UTC.*--force-hours/);
      }
      expect(requested).toEqual([]);
      expect(await lastRun()).toMatchObject({ status: 'succeeded', rowsRead: 0 });
      expect(await handle.db.select().from(sourceSyncRun)).toHaveLength(1);
    });

    it('runs inside them', async () => {
      expect(await runAt('2026-10-18T03:00:00Z')).toMatchObject({ status: 'succeeded' });
      expect(await runAt('2026-10-18T08:59:59Z')).toMatchObject({ status: 'succeeded' });
    });

    it('runs outside them with --force-hours or --only', async () => {
      expect(await runAt('2026-10-18T15:30:00Z', { forceHours: true })).toMatchObject({ status: 'succeeded' });
      expect(await runAt('2026-10-18T15:30:00Z', { only: ['99-19'] })).toMatchObject({ status: 'succeeded' });
    });
  });

  it('is idempotent', async () => {
    await run();
    const second = await run();
    expect(second).toMatchObject({ rowsInserted: 0, rowsUpdated: 0, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe((await handle.db.select().from(notice)).length);
    expect((await listings()).every((r) => r.missedRuns === 0)).toBe(true);
  });

  it('keeps a listing missing once', async () => {
    await run();
    const eventsBefore = await total(changeEvent);
    serve('99-19', withoutFirstFirm(ORIGINAL['99-19']));
    await run();
    const key = keyOf('99-19', parsed('99-19').listings[0]);
    const [row] = (await listings()).filter((r) => r.listingKey === key);
    expect(row).toMatchObject({ missedRuns: 1, removedOn: null });
    expect(await total(changeEvent)).toBe(eventsBefore);
  });

  it('delists after two consecutive misses', async () => {
    await run();
    const eventsBefore = await total(changeEvent);
    serve('99-19', withoutFirstFirm(ORIGINAL['99-19']));
    await run();
    const third = await run();
    const key = keyOf('99-19', parsed('99-19').listings[0]);
    const [row] = (await listings()).filter((r) => r.listingKey === key);
    expect(row).toMatchObject({ missedRuns: 2, removedOn: TODAY });
    const delisted = (await events()).filter((e) => e.kind === 'import_alert_delisted');
    expect(delisted).toHaveLength(1);
    expect(delisted[0]).toMatchObject({ sourceKey: key, occurredOn: TODAY, requiresFirm: true, severity: 'normal' });
    expect(delisted[0].noticeId).not.toBeNull();
    expect(delisted[0].commodityId).not.toBeNull();
    expect(await total(changeEvent)).toBe(eventsBefore + 1);
    expect(third.rowsUpdated).toBe(1);

    // A fourth run changes nothing: the listing is already removed.
    const fourth = await run();
    expect(fourth).toMatchObject({ rowsUpdated: 0, eventsEmitted: 0 });
  });

  it('lists a removed listing again when it comes back', async () => {
    await run();
    serve('99-19', withoutFirstFirm(ORIGINAL['99-19']));
    await run();
    await run();
    serve('99-19', ORIGINAL['99-19']);
    const back = await run();
    const key = keyOf('99-19', parsed('99-19').listings[0]);
    const [row] = (await listings()).filter((r) => r.listingKey === key);
    expect(row).toMatchObject({ missedRuns: 0, removedOn: null });
    expect(back.eventsEmitted).toBe(1);
    const last = (await events()).at(-1);
    expect(last).toMatchObject({ kind: 'import_alert_listed', sourceKey: key });
  });

  it('does not count a failed run as a miss', async () => {
    await run();
    const before = await listings();
    const eventsBefore = await total(changeEvent);
    serve('99-19', withoutFirstFirm(ORIGINAL['99-19']));
    serve('99-08', fixture('broken-no-anchor.html'));

    await expect(run()).rejects.toThrow(/RedFirm|list anchor/);
    expect((await lastRun()).status).toBe('failed');
    expect((await lastRun()).error).toMatch(/PageStructureError/);
    const samples = readdirSync(failureDir).filter((f) => /^99-08-.*\.html$/.test(f));
    expect(samples).toHaveLength(1);
    expect(readFileSync(path.join(failureDir, samples[0]), 'utf8')).toBe(fixture('broken-no-anchor.html'));
    expect(await listings()).toEqual(before);
    expect(await total(changeEvent)).toBe(eventsBefore);
  });

  it('fails without writing when the index changes shape, saving the index as a sample', async () => {
    index = INDEX.replace('Import Alert Number', 'Alert No.');
    await expect(run()).rejects.toThrow(/Import Alert index/);
    expect(await total(importAlert)).toBe(0);
    expect(readdirSync(failureDir).some((f) => f.startsWith('index-'))).toBe(true);
  });

  it('emits listed for a new product on an existing listing', async () => {
    serve('99-19', withoutFenugreek(ORIGINAL['99-19']));
    await run();
    const eventsBefore = await total(changeEvent);
    serve('99-19', ORIGINAL['99-19']);
    const second = await run();
    expect(second.eventsEmitted).toBe(1);
    const evs = await events();
    expect(evs).toHaveLength(eventsBefore + 1);
    const added = evs.at(-1);
    expect(added).toMatchObject({ kind: 'import_alert_listed', sourceKey: keyOf('99-19', parsed('99-19').listings[0]) });
    expect((added?.payload as { newProducts: string[] }).newProducts).toEqual(['28A--56']);
    const products = await handle.db
      .select()
      .from(importAlertListingProduct)
      .innerJoin(importAlertListing, eq(importAlertListing.id, importAlertListingProduct.listingId))
      .where(eq(importAlertListing.listingKey, added?.sourceKey ?? ''));
    expect(products.map((p) => p.import_alert_listing_product.productCode)).toContain('28A--56');
  });

  it('keeps one listing when FDA repeats a firm block', async () => {
    const block = /<div class="div-info">[\s\S]*?(?=\s*<hr\/>\s*<div class="center"><h4>ALBANIA)/.exec(ORIGINAL['99-19'])?.[0] as string;
    expect(block).toBeTruthy();
    serve('99-19', ORIGINAL['99-19'].replace(block, `${block}
${block}`));
    const result = await run();
    const baseline = parsed('99-19');
    const keys = new Set(baseline.listings.map((l) => keyOf('99-19', l)));
    expect(result.rowsRead).toBe(keys.size + parsed('99-08').listings.length + parsed('16-131').listings.length);
    const first = (await listings()).find((r) => r.listingKey === keyOf('99-19', baseline.listings[0]));
    const products = await handle.db.select().from(importAlertListingProduct).where(eq(importAlertListingProduct.listingId, first?.id ?? 0));
    expect(products).toHaveLength(baseline.listings[0].products.length);
    expect((await run()).rowsUpdated).toBe(0);
  });

  it('red to green emits delisted', async () => {
    await run();
    const eventsBefore = await total(changeEvent);
    const changed = lastSectionGreen(ORIGINAL['99-19']);
    const green = parsed('99-19', changed).listings.filter((l) => l.list === 'green');
    expect(green.length).toBeGreaterThan(0);
    serve('99-19', changed);
    await run();

    const keys = green.map((l) => keyOf('99-19', l));
    const rows = (await listings()).filter((r) => keys.includes(r.listingKey));
    expect(rows).toHaveLength(green.length);
    expect(rows.every((r) => r.list === 'green' && r.removedOn === null && r.missedRuns === 0)).toBe(true);
    const evs = await events();
    expect(evs).toHaveLength(eventsBefore + green.length);
    const delisted = evs.filter((e) => e.kind === 'import_alert_delisted');
    expect(delisted.map((e) => e.sourceKey).sort()).toEqual([...keys].sort());
  });

  it('green to red emits listed', async () => {
    serve('99-19', lastSectionGreen(ORIGINAL['99-19']));
    await run();
    const eventsBefore = await total(changeEvent);
    serve('99-19', ORIGINAL['99-19']);
    const second = await run();
    const flipped = parsed('99-19', lastSectionGreen(ORIGINAL['99-19'])).listings.filter((l) => l.list === 'green');
    expect(second.eventsEmitted).toBe(flipped.length);
    expect(await total(changeEvent)).toBe(eventsBefore + flipped.length);
    expect((await events()).at(-1)?.kind).toBe('import_alert_listed');
  });

  it('changes text_sha256 when the reason changes', async () => {
    await run();
    const [before] = await handle.db.select().from(importAlert).where(eq(importAlert.number, '99-19'));
    const changed = ORIGINAL['99-19'].replace('<h3>Reason for Alert:</h3>', '<h3>Reason for Alert:</h3><div>FDA added a new reason.</div><h3>Old reason:</h3>');
    expect(changed).not.toBe(ORIGINAL['99-19']);
    serve('99-19', changed);
    const second = await run();
    const [after] = await handle.db.select().from(importAlert).where(eq(importAlert.number, '99-19'));
    expect(after.textSha256).not.toBe(before.textSha256);
    expect(after.reasonText).toContain('FDA added a new reason.');
    expect(second.eventsEmitted).toBe(0);
  });

  it('marks an alert that left the index as removed and misses its listings', async () => {
    await run();
    index = INDEX.replace(/<tr>\s*<td>99-08<\/td>[\s\S]*?<\/tr>/, '');
    expect(index).not.toBe(INDEX);
    await run();
    const [gone] = await handle.db.select().from(importAlert).where(eq(importAlert.number, '99-08'));
    expect(gone.removedAt).not.toBeNull();
    const rows = (await listings()).filter((r) => r.alertNumber === '99-08');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.missedRuns === 1 && r.removedOn === null)).toBe(true);
    const eventsBefore = await total(changeEvent);

    await run();
    const rows2 = (await listings()).filter((r) => r.alertNumber === '99-08');
    expect(rows2.every((r) => r.missedRuns === 2 && r.removedOn === TODAY)).toBe(true);
    const red = parsed('99-08').listings.filter((l) => l.list === 'red').length;
    expect(await total(changeEvent)).toBe(eventsBefore + red);
    // Other alerts are untouched.
    expect((await listings()).filter((r) => r.alertNumber !== '99-08').every((r) => r.missedRuns === 0)).toBe(true);
  });

  it('crawls only the requested alerts but still reads the whole index', async () => {
    const result = await run({ only: ['99-19'] });
    expect(requested).toEqual([IMPORT_ALERT_INDEX_URL, URLS['99-19']]);
    expect(result.rowsRead).toBe(parsed('99-19').listings.length);
    expect(await total(importAlert)).toBe(1);
    await expect(run({ only: ['99-77'] })).rejects.toThrow(/99-77/);
  });

  it('--no-events writes rows and notices but no events', async () => {
    const result = await run({ events: false });
    expect(result.eventsEmitted).toBe(0);
    expect(await total(changeEvent)).toBe(0);
    expect(await total(notice)).toBeGreaterThan(0);
    expect(await total(importAlertListing)).toBeGreaterThan(0);
  });

  describe('fix round 1', () => {
    const firstBlock = () => {
      const block = /<div class="div-info">[\s\S]*?(?=\s*<hr\/>\s*<div class="center"><h4>ALBANIA)/.exec(ORIGINAL['99-19'])?.[0];
      expect(block).toBeTruthy();
      return block as string;
    };
    const fenugreek = () => {
      const product = /\s*<div>\s*<div class="floatleft"><em>28&nbsp;A&nbsp;-&nbsp;-&nbsp;56 <\/em>[\s\S]*?<\/p>/.exec(firstBlock())?.[0];
      expect(product).toBeTruthy();
      return product as string;
    };
    const firstKey = () => keyOf('99-19', parsed('99-19').listings[0]);
    const productsOf = async (key: string) =>
      (
        await handle.db
          .select({ product: importAlertListingProduct })
          .from(importAlertListingProduct)
          .innerJoin(importAlertListing, eq(importAlertListing.id, importAlertListingProduct.listingId))
          .where(eq(importAlertListing.listingKey, key))
          .orderBy(importAlertListingProduct.id)
      ).map((row) => row.product);

    it('keeps only the red blocks products when a firm is on both lists', async () => {
      const redOnly = withoutFenugreek(ORIGINAL['99-19']);
      const info = /^[\s\S]*?(?=\s*<div>\s*<div class="floatleft">)/.exec(firstBlock())?.[0] as string;
      const at = Math.max(...[...redOnly.matchAll(/<hr\/>\s*<div class="center"><h4>/g)].map((m) => m.index ?? -1));
      const both =
        `${redOnly.slice(0, at)}<hr/><div class="center"><a name="GreenFirm"></a><h4>Green List</h4></div>` +
        `<hr/><div class="center"><h4>AFGHANISTAN</h4></div><hr/>${info}${fenugreek()}` +
        `<hr/><div class="center"><a name="RedFirm"></a><h4>Red List</h4></div>${redOnly.slice(at)}`;

      const page = parsed('99-19', both);
      const mine = page.listings.filter((l) => keyOf('99-19', l) === firstKey());
      expect(mine.map((l) => l.list).sort()).toEqual(['green', 'red']);

      serve('99-19', redOnly);
      await run();
      serve('99-19', both);
      const second = await run();
      expect(second).toMatchObject({ eventsEmitted: 0, rowsUpdated: 0 });
      const [row] = (await listings()).filter((r) => r.listingKey === firstKey());
      expect(row.list).toBe('red');
      const codes = (await productsOf(firstKey())).map((p) => p.productCode);
      expect(codes).not.toContain('28A--56');
      expect(codes).toHaveLength(4);
      expect(JSON.stringify(await events())).not.toContain('28A--56');
    });

    it('does not call a product that dropped out and came back new, and keeps its row', async () => {
      await run();
      const before = await productsOf(firstKey());
      const eventsBefore = await total(changeEvent);

      serve('99-19', withoutFenugreek(ORIGINAL['99-19']));
      const dropped = await run();
      expect(dropped.eventsEmitted).toBe(0);
      const after = await productsOf(firstKey());
      expect(after).toHaveLength(before.length);
      expect(after.find((p) => p.productCode === '28A--56')?.removedOn).toBe(TODAY);
      expect(after.filter((p) => p.productCode !== '28A--56').every((p) => p.removedOn === null)).toBe(true);
      expect(await total(changeEvent)).toBe(eventsBefore);

      serve('99-19', ORIGINAL['99-19']);
      const back = await run();
      expect(back.eventsEmitted).toBe(0);
      const restored = await productsOf(firstKey());
      expect(restored.map((p) => p.id)).toEqual(before.map((p) => p.id));
      expect(restored.every((p) => p.removedOn === null)).toBe(true);
      expect(await total(changeEvent)).toBe(eventsBefore);
    });

    it('stores the full problems and its page position, and stays idempotent', async () => {
      await run();
      const page = parsed('99-19').listings.find((l) => keyOf('99-19', l) === firstKey()) as ParsedListing;
      const stored = await productsOf(firstKey());
      expect(stored.map((p) => p.position)).toEqual(page.products.map((_, i) => i));
      const alb = parsed('99-19').listings.find((l) => l.products.some((p) => p.problems.length > 0)) as ParsedListing;
      const albStored = await productsOf(keyOf('99-19', alb));
      expect(albStored.map((p) => p.problems)).toEqual(alb.products.map((p) => p.problems));
      expect(albStored.some((p) => p.problems.length > 0)).toBe(true);

      const again = await run();
      expect(again).toMatchObject({ rowsUpdated: 0, eventsEmitted: 0 });
    });

    it('moves the position of a product that reappears later on the page without an event', async () => {
      await run();
      const eventsBefore = await total(changeEvent);
      const without = firstBlock().replace(/\s*<div>\s*<div class="floatleft"><em>24&nbsp;T&nbsp;-&nbsp;-&nbsp;99 <\/em>[\s\S]*?<\/p>/, '');
      const veg = /\s*<div>\s*<div class="floatleft"><em>24&nbsp;T&nbsp;-&nbsp;-&nbsp;99 <\/em>[\s\S]*?<\/p>/.exec(firstBlock())?.[0] as string;
      const end = without.lastIndexOf('</p>') + 4;
      serve('99-19', ORIGINAL['99-19'].replace(firstBlock(), without));
      await run();
      serve('99-19', ORIGINAL['99-19'].replace(firstBlock(), `${without.slice(0, end)}${veg}${without.slice(end)}`));
      const back = await run();
      expect(back.eventsEmitted).toBe(0);
      const rows = await productsOf(firstKey());
      const moved = rows.find((p) => p.productCode === '24T--99');
      expect(moved?.removedOn).toBeNull();
      expect(moved?.position).toBe(4);
      expect(rows.filter((p) => p.productCode !== '24T--99').map((p) => p.position).sort()).toEqual([0, 1, 2, 3]);
      expect(await total(changeEvent)).toBe(eventsBefore);
    });

    it('updates product fields in place', async () => {
      await run();
      const before = await productsOf(firstKey());
      serve('99-19', ORIGINAL['99-19'].replace(firstBlock(), firstBlock().split('Fenugreek Leaves (Dried)').join('Fenugreek Leaves (Fresh)')));
      const second = await run();
      expect(second.eventsEmitted).toBe(0);
      const after = await productsOf(firstKey());
      expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
      expect(after.every((p) => p.description === 'Fenugreek Leaves (Fresh)')).toBe(true);
    });

    it('builds the notice product text from current products only', async () => {
      await run();
      serve('99-19', withoutFenugreek(ORIGINAL['99-19']));
      await run();
      const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, firstKey()));
      expect(n.productText).not.toContain('Fenugreek, Whole');
      expect(n.productText).toContain('Leaf & Stem Vegetables');
    });

    it('re-keys a listing whose address was edited instead of delisting and listing', async () => {
      await run();
      const [old] = (await listings()).filter((r) => r.listingKey === firstKey());
      const [oldNotice] = await handle.db.select().from(notice).where(eq(notice.sourceKey, firstKey()));
      const eventsBefore = await total(changeEvent);
      const noticesBefore = await total(notice);
      const edited = ORIGINAL['99-19'].replace('Bazaar Kandharyellow Carvansera', 'Bazaar Kandhar Yellow Carvansera Road 9');
      expect(edited).not.toBe(ORIGINAL['99-19']);
      const newKey = keyOf('99-19', parsed('99-19', edited).listings[0]);
      expect(newKey).not.toBe(firstKey());
      serve('99-19', edited);
      const second = await run();

      expect(second).toMatchObject({ eventsEmitted: 0, rowsInserted: 0 });
      expect(await total(changeEvent)).toBe(eventsBefore);
      expect(await total(notice)).toBe(noticesBefore);
      const rows = await listings();
      const moved = rows.find((r) => r.id === old.id);
      expect(moved).toMatchObject({ listingKey: newKey, missedRuns: 0, removedOn: null, firstSeenOn: TODAY });
      expect(moved?.addressRaw).toContain('Yellow Carvansera Road 9');
      expect(rows.filter((r) => r.alertNumber === '99-19')).toHaveLength(parsed('99-19').listings.length);
      const [movedNotice] = await handle.db.select().from(notice).where(eq(notice.sourceKey, newKey));
      expect(movedNotice.id).toBe(oldNotice.id);
      expect(await handle.db.select().from(notice).where(eq(notice.sourceKey, firstKey()))).toHaveLength(0);
      expect((await run()).rowsUpdated).toBe(0);
    });

    it('re-keys on the raw name and country heading, not on the stored normalised name or country code', async () => {
      await run();
      // As if the matching normalisers changed after the listings were stored.
      await handle.db.update(importAlertListing).set({ nameNorm: 'renormalised', countryCode: 'ZZ' });
      const [old] = (await listings()).filter((r) => r.listingKey === firstKey());
      expect(old.countryName).toBe(parsed('99-19').listings[0].countryName);
      const eventsBefore = await total(changeEvent);
      const edited = ORIGINAL['99-19'].replace('Bazaar Kandharyellow Carvansera', 'Bazaar Kandhar Yellow Carvansera Road 9');
      const newKey = keyOf('99-19', parsed('99-19', edited).listings[0]);
      serve('99-19', edited);
      const second = await run();
      expect(second).toMatchObject({ eventsEmitted: 0, rowsInserted: 0 });
      expect(await total(changeEvent)).toBe(eventsBefore);
      expect((await listings()).find((r) => r.id === old.id)).toMatchObject({ listingKey: newKey, missedRuns: 0, removedOn: null });
    });

    it('does not re-key when the match is ambiguous', async () => {
      await run();
      // Two new keys for one name and country: both listings are new, the old one is missed.
      const block = firstBlock();
      const one = block.replace('Bazaar Kandharyellow Carvansera', 'Alpha Road 1');
      const two = block.replace('Bazaar Kandharyellow Carvansera', 'Beta Road 2');
      serve('99-19', ORIGINAL['99-19'].replace(block, `${one}\n${two}`));
      const second = await run();
      expect(second.rowsInserted).toBe(2);
      const [old] = (await listings()).filter((r) => r.listingKey === firstKey());
      expect(old).toMatchObject({ missedRuns: 1, removedOn: null });
    });

    it('flags an alert that stops passing the food filter without removing it or missing its listings', async () => {
      await run();
      const eventsBefore = await total(changeEvent);
      index = INDEX.replace(/(<td>99-08<\/td>[\s\S]*?<a [^>]*>)/, '$1Drug ');
      expect(index).not.toBe(INDEX);
      const second = await run();

      const [alert] = await handle.db.select().from(importAlert).where(eq(importAlert.number, '99-08'));
      expect(alert).toMatchObject({ isFood: false, removedAt: null });
      expect((await listings()).filter((r) => r.alertNumber === '99-08').every((r) => r.missedRuns === 0 && r.removedOn === null)).toBe(true);
      expect(second.eventsEmitted).toBe(0);
      expect(await total(changeEvent)).toBe(eventsBefore);
      expect(requested.filter((u) => u === URLS['99-08'])).toHaveLength(1); // fetched in run 1 only

      // Still a non-food alert on the next run: nothing changes.
      expect((await run()).rowsUpdated).toBe(0);
    });
  });

  describe("a listing's firm (P3-D8)", () => {
    const [first, second] = parsed('99-19').listings;
    const firstKey = keyOf('99-19', first);
    const secondKey = keyOf('99-19', second);

    /** Links these listings to a new firm at score 0.9, as entities:link would; returns the firm's id. */
    const link = async (keys: string[]) => {
      const firmId = await insertFirm(handle.db);
      await handle.db.update(importAlertListing).set({ firmId, linkScore: '0.9000' }).where(inArray(importAlertListing.listingKey, keys));
      return firmId;
    };
    const listing = async (key: string) => (await handle.db.select().from(importAlertListing).where(eq(importAlertListing.listingKey, key)))[0];

    it('a listing whose firm name changes loses its firm', async () => {
      await run();
      const firmId = await link([firstKey, secondKey]);
      // "&" becomes ",": the key's canonical name drops both, so it is the same listing, but the normalised name loses
      // the "and" that the "&" stood for.
      const renamed = ORIGINAL['99-19'].replace('Mohamad Mahroof & Mahmood Haidar', 'Mohamad Mahroof, Mahmood Haidar');
      expect(keyOf('99-19', parsed('99-19', renamed).listings[0])).toBe(firstKey);
      serve('99-19', renamed);
      expect(await run()).toMatchObject({ rowsInserted: 0, rowsUpdated: 1 });
      expect(await listing(firstKey)).toMatchObject({
        firmName: 'Mohamad Mahroof, Mahmood Haidar',
        nameNorm: 'mohamad mahroof mahmood haidar',
        firmId: null,
        linkScore: null,
      });
      expect(await listing(secondKey)).toMatchObject({ firmId, linkScore: '0.9000' });
    });

    it('a listing whose country code changes loses its firm', async () => {
      await run();
      const firmId = await link([firstKey, secondKey]);
      // As if the code was stored under an earlier country-alias table: this run maps the heading to another code.
      await handle.db.update(importAlertListing).set({ countryCode: 'ZZ' }).where(eq(importAlertListing.listingKey, firstKey));
      expect(await run()).toMatchObject({ rowsInserted: 0, rowsUpdated: 1 });
      expect(await listing(firstKey)).toMatchObject({ countryCode: 'AF', firmId: null, linkScore: null });
      expect(await listing(secondKey)).toMatchObject({ firmId, linkScore: '0.9000' });
    });

    it('a listing re-keyed for an edited address keeps its firm', async () => {
      await run();
      const firmId = await link([firstKey]);
      const edited = ORIGINAL['99-19'].replace('Bazaar Kandharyellow Carvansera', 'Bazaar Kandhar Yellow Carvansera Road 9');
      const newKey = keyOf('99-19', parsed('99-19', edited).listings[0]);
      serve('99-19', edited);
      expect(await run()).toMatchObject({ rowsInserted: 0, rowsUpdated: 1 });
      // The address is not part of a listing's identity.
      expect(await listing(newKey)).toMatchObject({ addressRaw: expect.stringContaining('Road 9'), firmId, linkScore: '0.9000' });
    });

    it('a listing re-keyed for an edited address keeps its events and reviews', async () => {
      await run();
      expect((await events()).filter((e) => e.sourceKey === firstKey).map((e) => e.kind)).toEqual(['import_alert_listed']);
      const firmId = await link([firstKey]);
      const review = { firmId, candidateFirmId: await insertFirm(handle.db), score: '0.8100' };
      // An Australian test's review and event under the same key are about another record.
      await handle.db.insert(matchReview).values([
        { ...review, source: 'import_alert', sourceKey: firstKey },
        { ...review, source: 'au_ifis', sourceKey: firstKey },
      ]);
      await insertEvent(handle.db, { source: 'au_ifis', sourceKey: firstKey });
      const edited = ORIGINAL['99-19'].replace('Bazaar Kandharyellow Carvansera', 'Bazaar Kandhar Yellow Carvansera Road 9');
      const newKey = keyOf('99-19', parsed('99-19', edited).listings[0]);
      serve('99-19', edited);

      expect(await run()).toMatchObject({ rowsInserted: 0, rowsUpdated: 1, eventsEmitted: 0 });

      const keyOfRow = ({ source, sourceKey }: { source: string; sourceKey: string }) => `${source} ${sourceKey === newKey ? 'new key' : 'old key'}`;
      const eventKeys = await handle.db.select({ source: changeEvent.source, sourceKey: changeEvent.sourceKey }).from(changeEvent).where(inArray(changeEvent.sourceKey, [firstKey, newKey]));
      expect(eventKeys.map(keyOfRow).sort()).toEqual(['au_ifis old key', 'import_alert new key']);
      const reviewKeys = await handle.db.select({ source: matchReview.source, sourceKey: matchReview.sourceKey }).from(matchReview);
      expect(reviewKeys.map(keyOfRow).sort()).toEqual(['au_ifis old key', 'import_alert new key']);
    });
  });

  it('writes no sample file for a successful run', async () => {
    await run();
    expect(existsSync(failureDir) ? readdirSync(failureDir) : []).toEqual([]);
  });
});
