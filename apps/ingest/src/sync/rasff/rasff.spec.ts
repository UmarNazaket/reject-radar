import { changeEvent, notice, prepareTestDatabase, rasffNotification, sourceSyncRun } from '@rejectradar/db';
import { UNCLASSIFIED_ID } from '@rejectradar/taxonomy';
import { count, desc, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SyncDeps } from '../../core/deps';
import { openDb } from '../../core/db';
import type { FetchOptions } from '../../core/http';
import { loadRuleSet } from '../../core/rules';
import { fakeFetcher, fetchResult } from '../../core/test-fetcher';
import { parseDetail, parseSearchPage, rasffDetailUrl, rasffNoticeType, rasffPublicUrl, RASFF_SEARCH_URL, type RasffHazard, type RasffListItem } from './parse';
import { classifyRasff, syncRasff } from './sync';

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const PAGE1 = JSON.parse(fixture('search-page1.json')) as { notifications: Record<string, unknown>[]; totalPages: number; totalElements: number };
const PAGE2 = JSON.parse(fixture('search-page2.json')) as { notifications: Record<string, unknown>[] };
const DETAIL = fixture('detail-880124.json');
const TODAY = '2026-10-18';

describe('RASFF parsing', () => {
  it('parses list items', () => {
    const { items, totalPages } = parseSearchPage(PAGE1);
    expect(totalPages).toBe(331);
    expect(items).toHaveLength(100);
    const item = items.find((i) => i.reference === '2026.9213');
    expect(item).toMatchObject({
      notifId: 880124,
      notifiedOn: '2026-10-16',
      classification: 'border rejection notification',
      originCountries: ['IN'],
      productType: 'food',
    });
  });

  it('rejects a list item missing reference', () => {
    const broken = { ...PAGE1, notifications: [{ ...PAGE1.notifications[0], reference: undefined }, ...PAGE1.notifications.slice(1)] };
    expect(() => parseSearchPage(broken)).toThrow(/notifications\.0\.reference/);
  });

  it('rejects a date it cannot read', () => {
    const broken = { ...PAGE1, notifications: [{ ...PAGE1.notifications[0], ecValidationDate: '2026-10-16' }] };
    expect(() => parseSearchPage(broken)).toThrow(/notifications\.0\.ecValidationDate/);
  });

  it('drops personal data from details', () => {
    expect(DETAIL).toContain('contactPerson');
    const detail = parseDetail(JSON.parse(DETAIL));
    expect(detail.hazards).toHaveLength(1);
    expect(detail.hazards[0]).toMatchObject({
      name: 'Salmonella  - pathogenic micro-organisms',
      category: 'pathogenic micro-organisms',
      analyticalResult: 'Presence of Salmonella spp.',
      unit: '/25g',
    });
    expect(detail.originCountries).toEqual(['IN']);
    expect(detail.distributionCountries).toEqual(['GR']);
    const text = JSON.stringify(detail);
    expect(text).not.toContain('contactPerson');
    expect(text).not.toContain('additionalInformations');
    expect(text).not.toContain('Panagiota');
  });

  it('rejects a detail without a hazards list', () => {
    const broken = JSON.parse(DETAIL);
    delete broken.product.hazards;
    expect(() => parseDetail(broken)).toThrow(/product\.hazards/);
  });

  it('maps classifications to notice types', () => {
    expect(rasffNoticeType('border rejection notification')).toBe('rasff_border_rejection');
    expect(rasffNoticeType('alert notification')).toBe('rasff_alert');
    expect(rasffNoticeType('information notification for follow-up')).toBe('rasff_information');
    expect(rasffNoticeType('information notification for attention')).toBe('rasff_information');
    expect(rasffNoticeType('news')).toBe('rasff_other');
    expect(rasffNoticeType(null)).toBe('rasff_other');
  });

  it('builds the backend and public URLs', () => {
    expect(rasffDetailUrl(880124)).toBe('https://webgate.ec.europa.eu/rasff-window/backend/public/notification/view/id/880124/');
    expect(rasffPublicUrl(880124)).toBe('https://webgate.ec.europa.eu/rasff-window/screen/notification/880124');
  });
});

describe('RASFF sync', () => {
  let handle: ReturnType<typeof openDb>;
  let deps: SyncDeps;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_rasff'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.delete(changeEvent);
    await handle.db.delete(notice);
    await handle.db.delete(rasffNotification);
    await handle.db.delete(sourceSyncRun);
    const rules = await loadRuleSet(handle.db);
    deps = { db: handle.db, rules, today: () => TODAY, fetcher: fakeFetcher(() => fetchResult('')).fetcher };
  });

  /** Serves the list pages (by `pageNumber`) and the same detail for every notification. */
  const backend = (pages: Record<string, unknown>[] = [PAGE1, PAGE2], detail = DETAIL) => {
    const requested: { kind: 'list' | 'detail'; page?: number; url: string }[] = [];
    const fake = fakeFetcher((url: string, options?: FetchOptions) => {
      if (url === RASFF_SEARCH_URL) {
        expect(options?.method).toBe('POST');
        const page = (JSON.parse(options?.body ?? '{}') as { parameters: { pageNumber: number; itemsPerPage: number } }).parameters;
        expect(page.itemsPerPage).toBe(100);
        requested.push({ kind: 'list', page: page.pageNumber, url });
        const body = pages[page.pageNumber - 1] ?? { notifications: [], totalPages: pages.length, totalElements: 0 };
        return fetchResult(JSON.stringify(body), { contentType: 'application/json', url });
      }
      requested.push({ kind: 'detail', url });
      return fetchResult(detail, { contentType: 'application/json', url });
    });
    return { ...fake, requested };
  };
  const withBackend = (b: ReturnType<typeof backend>) => ({ ...deps, fetcher: b.fetcher });
  const lastRun = async () => (await handle.db.select().from(sourceSyncRun).orderBy(desc(sourceSyncRun.id)).limit(1))[0];
  const total = async (table: typeof notice | typeof changeEvent | typeof rasffNotification) =>
    Number((await handle.db.select({ n: count() }).from(table))[0].n);
  const foodItems = parseSearchPage(PAGE1).items.filter((i) => i.productType !== 'food contact material');
  const options = { detailsLimit: 0, events: true };
  /** A page whose rows are all moved back so far that it ends the paging. */
  const oldPage = { ...PAGE1, notifications: PAGE1.notifications.map((n) => ({ ...n, ecValidationDate: '01-01-2026 10:00:00' })) };

  it('stores food and feed notifications and skips food contact materials', async () => {
    expect(foodItems).toHaveLength(97);
    await syncRasff(withBackend(backend([oldPage])), options);
    expect(await total(rasffNotification)).toBe(97);
    expect(await total(notice)).toBe(97);
    const rows = await handle.db.select().from(rasffNotification).where(eq(rasffNotification.reference, '2026.9213'));
    expect(rows[0]).toMatchObject({
      notifiedOn: '2026-01-01',
      classification: 'border rejection notification',
      notifyingCountry: expect.any(String),
      originCountries: ['IN'],
      url: rasffPublicUrl(880124),
    });
    const run = await lastRun();
    expect(run).toMatchObject({ source: 'rasff', status: 'succeeded', rowsRead: 100, rowsInserted: 97, rowsUpdated: 0, eventsEmitted: 97 });
  });

  it('writes notices with the first origin country and the notice type', async () => {
    await syncRasff(withBackend(backend([PAGE1])), options);
    const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, '2026.9213'));
    expect(n).toMatchObject({
      source: 'rasff',
      noticeType: 'rasff_border_rejection',
      noticeOn: '2026-10-16',
      originCountry: 'IN',
      title: expect.stringContaining('Salmonella'),
      url: rasffPublicUrl(880124),
    });
    expect(n.hazardIds).toContain(400);
  });

  it('stops paging at the 30-day overlap', async () => {
    await handle.db.insert(rasffNotification).values({ reference: '2026.1', notifiedOn: '2026-10-10', subject: 'Stored' });

    // Page 1 reaches back to 2026-10-09, later than the 2026-09-10 cutoff, so page 2 is read.
    const both = backend();
    await syncRasff(withBackend(both), options);
    expect(both.requested.filter((r) => r.kind === 'list').map((r) => r.page)).toEqual([1, 2]);

    // Page 1 older than the cutoff ends the paging.
    const one = backend([{ ...PAGE1, notifications: PAGE1.notifications.map((n) => ({ ...n, ecValidationDate: '01-09-2026 10:00:00' })) }, PAGE2]);
    await syncRasff(withBackend(one), options);
    expect(one.requested.filter((r) => r.kind === 'list').map((r) => r.page)).toEqual([1]);
  });

  it('uses --from as the cutoff and stops at the last page', async () => {
    const b = backend([PAGE1, PAGE2]);
    await syncRasff(withBackend(b), { ...options, from: '2020-01-01' });
    // Neither page is older than the cutoff, so paging goes on until the (fake) backend returns an empty page.
    expect(b.requested.filter((r) => r.kind === 'list').map((r) => r.page)).toEqual([1, 2, 3]);
    const older = parseSearchPage({ ...PAGE2, totalPages: 1 }).items.filter((i) => i.productType !== 'food contact material');
    expect(await total(rasffNotification)).toBe(97 + older.length);
  });

  it('emits events only for new references', async () => {
    const b = backend([PAGE1]);
    const first = await syncRasff(withBackend(b), { ...options, from: '2026-10-01' });
    expect(first).toMatchObject({ rowsInserted: 97, eventsEmitted: 97 });
    const events = await handle.db.select().from(changeEvent);
    expect(events).toHaveLength(97);
    expect(events[0]).toMatchObject({ source: 'rasff', kind: 'rasff_notification', requiresFirm: false });
    const event = events.find((e) => e.sourceKey === '2026.9213');
    expect(event).toMatchObject({ occurredOn: '2026-10-16', originCountry: 'IN' });

    const changed = {
      ...PAGE1,
      notifications: PAGE1.notifications.map((n) => (n['reference'] === '2026.9213' ? { ...n, subject: 'Salmonella in sesame seeds, updated' } : n)),
    };
    const second = await syncRasff(withBackend(backend([changed])), { ...options, from: '2026-10-01' });
    expect(second).toMatchObject({ rowsInserted: 0, rowsUpdated: 1, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(97);
    const [updated] = await handle.db.select().from(notice).where(eq(notice.sourceKey, '2026.9213'));
    expect(updated.title).toBe('Salmonella in sesame seeds, updated');
  });

  it('emits no events with --no-events', async () => {
    const result = await syncRasff(withBackend(backend([oldPage])), { ...options, events: false });
    expect(result).toMatchObject({ rowsInserted: 97, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(0);
    expect(await total(notice)).toBe(97);
  });

  it('is idempotent', async () => {
    const run = () => syncRasff(withBackend(backend([PAGE1, PAGE2])), { ...options, from: '2020-01-01' });
    await run();
    const rows = await handle.db.select().from(rasffNotification);
    const again = await run();
    expect(again).toMatchObject({ rowsInserted: 0, rowsUpdated: 0, eventsEmitted: 0 });
    expect(await handle.db.select().from(rasffNotification)).toEqual(rows);
  });

  it('fills hazards from details within the limit', async () => {
    const b = backend([oldPage]);
    const result = await syncRasff(withBackend(b), { detailsLimit: 5, events: true });
    expect(b.requested.filter((r) => r.kind === 'detail')).toHaveLength(5);
    expect(result.rowsInserted).toBe(97);

    const filled = (await handle.db.select().from(rasffNotification)).filter((r) => (r.hazards as unknown[]).length > 0);
    expect(filled).toHaveLength(5);
    for (const row of filled) {
      expect(row.hazards).toEqual([
        expect.objectContaining({ name: 'Salmonella  - pathogenic micro-organisms', category: 'pathogenic micro-organisms' }),
      ]);
      expect(row.distributionCountries).toEqual(['GR']);
      expect(row.hazardIds).toContain(400);
    }
    const [row] = await handle.db.select().from(rasffNotification).where(eq(rasffNotification.reference, '2026.9213'));
    expect(row.hazardIds).toContain(400);
    expect(JSON.stringify(filled)).not.toContain('contactPerson');
  });

  it('fills the oldest stored rows without details first and re-classifies their notices', async () => {
    await syncRasff(withBackend(backend([oldPage])), options);
    // Make one stored row a clear oldest and give it a subject that names no hazard.
    await handle.db
      .update(rasffNotification)
      .set({ notifiedOn: '2025-06-01', subject: 'Consignment of sesame seeds', hazardIds: [900] })
      .where(eq(rasffNotification.reference, '2026.9213'));

    await handle.db.update(notice).set({ hazardIds: [900] }).where(eq(notice.sourceKey, '2026.9213'));

    const b = backend([{ ...oldPage, notifications: [], totalPages: 1 }]);
    const result = await syncRasff(withBackend(b), { detailsLimit: 1, events: true, from: '2026-12-01' });
    expect(b.requested.filter((r) => r.kind === 'detail').map((r) => r.url)).toEqual([rasffDetailUrl(880124)]);
    expect(result).toMatchObject({ rowsInserted: 0, rowsUpdated: 1, eventsEmitted: 0 });

    const [row] = await handle.db.select().from(rasffNotification).where(eq(rasffNotification.reference, '2026.9213'));
    expect(row.hazardIds).toContain(400);
    expect((row.hazards as unknown[]).length).toBe(1);
    const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, '2026.9213'));
    expect(n.hazardIds).toContain(400);
  });

  it('keeps stored hazards when a later list run sees the same notification again', async () => {
    await syncRasff(withBackend(backend([oldPage])), { detailsLimit: 100, events: false });
    const before = await handle.db.select().from(rasffNotification);
    expect(before.every((r) => (r.hazards as unknown[]).length === 1)).toBe(true);
    const again = await syncRasff(withBackend(backend([oldPage])), { detailsLimit: 100, events: false });
    expect(again).toMatchObject({ rowsInserted: 0, rowsUpdated: 0 });
    expect(await handle.db.select().from(rasffNotification)).toEqual(before);
  });

  it('writes nothing when the list is malformed', async () => {
    const broken = { ...PAGE1, notifications: [{ ...PAGE1.notifications[0], reference: undefined }] };
    await expect(syncRasff(withBackend(backend([broken])), options)).rejects.toThrow(/notifications\.0\.reference/);
    expect(await total(rasffNotification)).toBe(0);
    expect(await lastRun()).toMatchObject({ status: 'failed' });
  });
});

describe('classifyRasff', () => {
  let rules: Awaited<ReturnType<typeof loadRuleSet>>;
  let handle: ReturnType<typeof openDb>;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_rasff_classify'));
    rules = await loadRuleSet(handle.db);
  });
  afterAll(async () => {
    await handle.close();
  });

  const item = (subject: string, productCategory: string | null = 'nuts, nut products and seeds'): RasffListItem => ({
    notifId: 1,
    reference: '2026.1',
    notifiedOn: '2026-10-16',
    subject,
    productCategory,
    productType: 'food',
    classification: null,
    riskDecision: null,
    notifyingCountry: null,
    originCountries: [],
  });
  const hazard = (name: string, category: string | null): RasffHazard => ({ name, category, analyticalResult: null, unit: null, maxPermittedLvl: null });

  it('reads hazards from the subject before details', () => {
    expect(classifyRasff(rules, item('Salmonella spp. in sesame seeds from India'), []).hazardIds).toContain(400);
  });

  it('matches a hazard on its name first and on its category only when the name matches nothing', () => {
    const byName = classifyRasff(rules, item('Consignment of sesame seeds'), [hazard('Salmonella  - pathogenic micro-organisms', 'pathogenic micro-organisms')]);
    expect(byName.hazardIds).toContain(400);
    expect(byName.hazardIds).toEqual([400]);

    const byCategory = classifyRasff(rules, item('Consignment of sesame seeds'), [hazard('Something unnamed', 'pathogenic micro-organisms')]);
    expect(byCategory.hazardIds).not.toContain(400);
    expect(byCategory.hazardIds).not.toEqual([UNCLASSIFIED_ID]);
  });
});
