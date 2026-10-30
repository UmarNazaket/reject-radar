import { changeEvent, fdaChargeCode, fdaRefusal, notice, prepareTestDatabase, sourceSyncRun } from '@rejectradar/db';
import { insertFirm } from '@rejectradar/entities';
import { count, desc, eq, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SyncDeps } from '../../core/deps';
import { openDb } from '../../core/db';
import { SourceFetchError, type FetchOptions } from '../../core/http';
import { loadRuleSet } from '@rejectradar/taxonomy';
import { fakeFetcher, fetchResult } from '../../core/test-fetcher';
import { seedSucceededRun } from '../../core/test-sync-run';
import { parseChargeCodes, syncChargeCodes } from './charge-codes';
import { classifyRefusal, monthSlices, parseRefusal, syncFdaRefusals, type RefusalRecord } from './refusals';

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const PAGE1 = fixture('refusals-page1.json');
const CHARGES = fixture('charges.csv');
const CREDS = { user: 'u', key: 'k' };
const TODAY = '2026-10-18';

describe('parseRefusal and parseChargeCodes', () => {
  const raw = {
    ShipmentID: 'S-1',
    FEINumber: '3010500143',
    FirmName: ' Acme Foods Ltd. ',
    AddressLine1: ' 1 Main Rd ',
    AddressLine2: null,
    City: 'Mumbai',
    State: 'MH',
    ZipCode: ' 400001 ',
    CountryCode: 'IN',
    CountryName: 'India',
    DistrictCode: 'DNEI',
    IndustryCode: '7 ',
    ProductCode: '07ABC01',
    ProductCodeDescription: 'BREAD',
    ProductCategory: 'Human Foods',
    RefusalDate: '2026-09-01',
    RefusalCharges: '118,336',
    FDASampleAnalysis: 'No ',
    PrivateLabAnalysis: 'Yes',
    FirmProfile: 'https://datadashboard.fda.gov/oii/firmprofile.htm?FEIu=3010500143',
  };

  it('trims Yes/No and industry codes', () => {
    const record = parseRefusal({ ...raw, FDASampleAnalysis: 'No ', IndustryCode: '7 ' });
    expect(record.fdaSampleAnalysis).toBe(false);
    expect(record.privateLabAnalysis).toBe(true);
    expect(record.industryCode).toBe('7');
    expect(record.firmName).toBe('Acme Foods Ltd.');
    expect(record.fei).toBe(3010500143);
    expect(record.countryCode).toBe('IN');
    expect(parseRefusal({ ...raw, FDASampleAnalysis: '', PrivateLabAnalysis: null }).fdaSampleAnalysis).toBeNull();
  });

  it('splits charge codes', () => {
    expect(parseRefusal({ ...raw, RefusalCharges: '118,336' }).chargeCodes).toEqual(['118', '336']);
    expect(parseRefusal({ ...raw, RefusalCharges: '' }).chargeCodes).toEqual([]);
    expect(parseRefusal({ ...raw, RefusalCharges: null }).chargeCodes).toEqual([]);
  });

  it('throws on a missing ShipmentID, FirmName or RefusalDate', () => {
    expect(() => parseRefusal({ ...raw, ShipmentID: null })).toThrow(/ShipmentID/);
    expect(() => parseRefusal({ ...raw, FirmName: ' ' })).toThrow(/FirmName/);
    expect(() => parseRefusal({ ...raw, RefusalDate: undefined })).toThrow(/RefusalDate/);
  });

  it('parses the charge-code file keyed by ASC_ID', () => {
    const codes = parseChargeCodes(CHARGES);
    expect(codes).toHaveLength(287);
    expect(codes.find((c) => c.name === 'SALMONELLA')).toMatchObject({ code: '9', section: expect.stringContaining('ADULTERATION') });
  });
});

describe('FDA refusals sync', () => {
  let handle: ReturnType<typeof openDb>;
  let deps: SyncDeps;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_fda'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handle.db.delete(changeEvent);
    await handle.db.delete(notice);
    await handle.db.delete(fdaRefusal);
    await handle.db.delete(fdaChargeCode);
    await handle.db.delete(sourceSyncRun);
    // Not a first load, unless a test deletes this run: events are emitted as asked.
    await seedSucceededRun(handle.db, 'fda_refusals');
    const rules = await loadRuleSet(handle.db);
    deps = { db: handle.db, rules, today: () => TODAY, fetcher: fakeFetcher(() => fetchResult('')).fetcher };
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const api = (respond: (body: Record<string, unknown>) => string, status = 200) =>
    fakeFetcher((url: string, options?: FetchOptions) =>
      fetchResult(respond(JSON.parse(options?.body ?? '{}')), { status, contentType: 'application/json', url }),
    );
  const withApi = (fake: ReturnType<typeof api>) => ({ ...deps, fetcher: fake.fetcher, creds: CREDS });
  const lastRun = async () => (await handle.db.select().from(sourceSyncRun).orderBy(desc(sourceSyncRun.id)).limit(1))[0];
  const total = async (table: typeof notice | typeof changeEvent | typeof fdaRefusal | typeof fdaChargeCode) =>
    Number((await handle.db.select({ n: count() }).from(table))[0].n);
  const loadCharges = async () => {
    const charges = fakeFetcher((url) => fetchResult(CHARGES, { contentType: 'text/csv', url }));
    return syncChargeCodes({ ...deps, fetcher: charges.fetcher });
  };
  const options = { from: '2026-09-01', to: '2026-09-30', events: true };

  it('loads charge codes with hazards', async () => {
    const result = await loadCharges();
    expect(result.rowsRead).toBe(287);
    expect(await total(fdaChargeCode)).toBe(287);
    const salmonella = await handle.db.select().from(fdaChargeCode).where(eq(fdaChargeCode.name, 'SALMONELLA'));
    expect(salmonella[0]).toMatchObject({ code: '9', hazardId: 400 });
    const unfit = await handle.db.select().from(fdaChargeCode).where(eq(fdaChargeCode.name, 'UNFIT4FOOD'));
    expect(unfit[0].hazardId).toBe(900);
    expect((await lastRun()).source).toBe('fda_charge_codes');
    const again = await loadCharges();
    expect(again).toMatchObject({ rowsInserted: 0, rowsUpdated: 0 });
  });

  it('records no charge-code counts for a run whose transaction failed', async () => {
    const transaction = handle.db.transaction.bind(handle.db);
    const spy = jest.spyOn(handle.db, 'transaction').mockImplementation(((work: Parameters<typeof transaction>[0]) =>
      transaction(async (tx) => {
        await work(tx);
        throw new Error('commit failed');
      })) as typeof transaction);
    try {
      await expect(loadCharges()).rejects.toThrow('commit failed');
    } finally {
      spy.mockRestore();
    }
    expect(await total(fdaChargeCode)).toBe(0);
    expect(await lastRun()).toMatchObject({ source: 'fda_charge_codes', status: 'failed', rowsRead: 287, rowsInserted: 0, rowsUpdated: 0 });
  });

  it('writes refusals, notices and events', async () => {
    await loadCharges();
    const result = await syncFdaRefusals(withApi(api(() => PAGE1)), options);

    expect(result).toMatchObject({ rowsRead: 120, rowsInserted: 120, rowsUpdated: 0, eventsEmitted: 120 });
    expect(await total(fdaRefusal)).toBe(120);
    const notices = await handle.db.select().from(notice).where(eq(notice.source, 'fda_refusal'));
    expect(notices).toHaveLength(120);
    expect(notices.every((n) => n.destination === 'US' && n.noticeType === 'refusal')).toBe(true);
    expect(notices.every((n) => n.url?.startsWith('https://datadashboard.fda.gov/oii/firmprofile.htm?FEIu='))).toBe(true);
    expect(notices.every((n) => n.commodityId !== null && n.hazardIds.length > 0)).toBe(true);
    expect(notices.some((n) => n.hazardIds.some((id) => id !== 1200))).toBe(true);
    const events = await handle.db.select().from(changeEvent);
    expect(events).toHaveLength(120);
    expect(events.every((e) => e.kind === 'fda_refusal' && e.severity === 'high' && e.requiresFirm && e.firmId === null)).toBe(true);
    expect(await lastRun()).toMatchObject({ source: 'fda_refusals', status: 'succeeded', rowsRead: 120, rowsInserted: 120, eventsEmitted: 120 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the charge codes are not loaded', async () => {
    await syncFdaRefusals(withApi(api(() => PAGE1)), { ...options, events: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sync:fda-charge-codes'));
  });

  it('sends the food filter, sort and date window to the API', async () => {
    const fake = api(() => PAGE1);
    await syncFdaRefusals(withApi(fake), { ...options, events: false });
    const body = JSON.parse(fake.calls[0].options?.body ?? '{}');
    expect(body.filters).toEqual({
      RefusalDateFrom: ['2026-09-01'],
      RefusalDateTo: ['2026-09-30'],
      ProductCategory: ['Human Foods', 'Animal Feed'],
    });
    expect(body.sort).toBe('RefusalDate');
  });

  it('is idempotent', async () => {
    const fake = api(() => PAGE1);
    await syncFdaRefusals(withApi(fake), options);
    const second = await syncFdaRefusals(withApi(fake), options);
    expect(second).toMatchObject({ rowsRead: 120, rowsInserted: 0, rowsUpdated: 0, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(120);
    expect(await total(fdaRefusal)).toBe(120);
    expect(await lastRun()).toMatchObject({ status: 'succeeded', rowsInserted: 0, eventsEmitted: 0 });
  });

  it('counts a changed refusal as updated and emits no event for it', async () => {
    const page = JSON.parse(PAGE1);
    await syncFdaRefusals(withApi(api(() => PAGE1)), options);
    page.result[0].ProductCodeDescription = 'SOMETHING ELSE ENTIRELY';
    const second = await syncFdaRefusals(withApi(api(() => JSON.stringify(page))), options);
    expect(second).toMatchObject({ rowsInserted: 0, rowsUpdated: 1, eventsEmitted: 0 });
    const [row] = await handle.db.select().from(fdaRefusal).where(eq(fdaRefusal.sourceKey, page.result[0].ShipmentID));
    expect(row.productDesc).toBe('SOMETHING ELSE ENTIRELY');
  });

  /** Links these refusals to a new firm at score 0.95, as entities:link would; returns the firm's id. */
  const link = async (keys: string[]) => {
    const firmId = await insertFirm(handle.db);
    await handle.db.update(fdaRefusal).set({ firmId, linkScore: '0.9500' }).where(inArray(fdaRefusal.sourceKey, keys));
    return firmId;
  };
  const refusal = async (key: string) => (await handle.db.select().from(fdaRefusal).where(eq(fdaRefusal.sourceKey, key)))[0];

  it("a re-read with a new FEI clears the refusal's firm", async () => {
    const page = JSON.parse(PAGE1);
    await syncFdaRefusals(withApi(api(() => PAGE1)), options);
    // Two refusals of one firm, both linked; FDA then corrects the FEI of the first.
    const [corrected, other] = [page.result[0].ShipmentID, page.result[1].ShipmentID];
    const firmId = await link([corrected, other]);
    page.result[0].FEINumber = '3099999999';
    const second = await syncFdaRefusals(withApi(api(() => JSON.stringify(page))), options);
    expect(second).toMatchObject({ rowsInserted: 0, rowsUpdated: 1 });
    expect(await refusal(corrected)).toMatchObject({ fei: 3099999999, firmId: null, linkScore: null });
    expect(await refusal(other)).toMatchObject({ fei: 3010500143, firmId, linkScore: '0.9500' });
  });

  it("a re-read with a new firm name or country clears the refusal's firm", async () => {
    const page = JSON.parse(PAGE1);
    await syncFdaRefusals(withApi(api(() => PAGE1)), options);
    const [renamed, moved, other] = [2, 3, 4].map((i) => page.result[i].ShipmentID as string);
    const firmId = await link([renamed, moved, other]);
    page.result[2].FirmName = 'DASENLIN FOODSTUFF CO., LTD';
    Object.assign(page.result[3], { CountryCode: 'HK', CountryName: 'Hong Kong' });
    const second = await syncFdaRefusals(withApi(api(() => JSON.stringify(page))), options);
    expect(second).toMatchObject({ rowsInserted: 0, rowsUpdated: 2 });
    expect(await refusal(renamed)).toMatchObject({ nameNorm: 'dasenlin foodstuff', firmId: null, linkScore: null });
    expect(await refusal(moved)).toMatchObject({ countryCode: 'HK', firmId: null, linkScore: null });
    expect(await refusal(other)).toMatchObject({ firmId, linkScore: '0.9500' });
  });

  it('an unchanged re-read keeps it', async () => {
    const page = JSON.parse(PAGE1);
    await syncFdaRefusals(withApi(api(() => PAGE1)), options);
    const key = page.result[0].ShipmentID;
    const firmId = await link([key]);
    expect(await syncFdaRefusals(withApi(api(() => PAGE1)), options)).toMatchObject({ rowsUpdated: 0 });
    expect(await refusal(key)).toMatchObject({ firmId, linkScore: '0.9500' });

    // Fields outside the identity change, and so does the raw name, but not its normalised form: the row is rewritten
    // and keeps its firm.
    page.result[0].ProductCodeDescription = 'SOMETHING ELSE ENTIRELY';
    page.result[0].FirmName = 'LEVANT FOOD PRODUCTS COMPANY LTD.';
    expect(await syncFdaRefusals(withApi(api(() => JSON.stringify(page))), options)).toMatchObject({ rowsUpdated: 1 });
    expect(await refusal(key)).toMatchObject({
      firmName: 'LEVANT FOOD PRODUCTS COMPANY LTD.',
      productDesc: 'SOMETHING ELSE ENTIRELY',
      firmId,
      linkScore: '0.9500',
    });
  });

  it('suppresses events on a first load, then emits them', async () => {
    await handle.db.delete(sourceSyncRun);
    const page = JSON.parse(PAGE1);
    const [kept] = page.result.splice(0, 1);
    const first = await syncFdaRefusals(withApi(api(() => JSON.stringify(page))), options);
    expect(first).toMatchObject({ status: 'succeeded', rowsInserted: 119, eventsEmitted: 0 });
    expect(warn).toHaveBeenCalledWith('first load of fda_refusals: events suppressed');
    page.result.unshift(kept);
    const second = await syncFdaRefusals(withApi(api(() => JSON.stringify(page))), options);
    expect(second).toMatchObject({ rowsInserted: 1, eventsEmitted: 1 });
    expect(await total(changeEvent)).toBe(1);
  });

  it('--no-events writes rows but no events', async () => {
    const result = await syncFdaRefusals(withApi(api(() => PAGE1)), { ...options, events: false });
    expect(result.eventsEmitted).toBe(0);
    expect(await total(fdaRefusal)).toBe(120);
    expect(await total(notice)).toBe(120);
    expect(await total(changeEvent)).toBe(0);
  });

  const windows = (fake: ReturnType<typeof api>) =>
    fake.calls.map((c) => {
      const filters = JSON.parse(c.options?.body ?? '{}').filters;
      return `${filters.RefusalDateFrom[0]}/${filters.RefusalDateTo[0]}`;
    });

  it('re-reads the last 120 days by default, one calendar month at a time', async () => {
    const fake = api(() => PAGE1);
    const result = await syncFdaRefusals(withApi(fake), { events: false });
    expect(windows(fake)).toEqual([
      '2026-06-20/2026-06-30',
      '2026-07-01/2026-07-31',
      '2026-08-01/2026-08-31',
      '2026-09-01/2026-09-30',
      '2026-10-01/2026-10-18',
    ]);
    expect(result.rowsRead).toBe(600);
    expect(await total(fdaRefusal)).toBe(120);
  });

  it('splits a window into calendar-month slices', async () => {
    const fake = api(() => PAGE1);
    await syncFdaRefusals(withApi(fake), { from: '2026-08-15', to: '2026-09-30', events: false });
    expect(windows(fake)).toEqual(['2026-08-15/2026-08-31', '2026-09-01/2026-09-30']);
  });

  it('slices across year ends, leap Februaries and single days', () => {
    expect(monthSlices('2023-12-30', '2024-03-01')).toEqual([
      { from: '2023-12-30', to: '2023-12-31' },
      { from: '2024-01-01', to: '2024-01-31' },
      { from: '2024-02-01', to: '2024-02-29' },
      { from: '2024-03-01', to: '2024-03-01' },
    ]);
    expect(monthSlices('2026-09-10', '2026-09-10')).toEqual([{ from: '2026-09-10', to: '2026-09-10' }]);
    expect(monthSlices('2026-09-11', '2026-09-10')).toEqual([]);
  });

  it('fails when a slice exceeds 20 pages', async () => {
    const template = JSON.parse(PAGE1).result[0];
    const full = JSON.stringify({
      statuscode: 400,
      message: 'Success.',
      result: Array.from({ length: 5000 }, (_, i) => ({ ...template, ShipmentID: `F-${i}` })),
    });
    const fake = api(() => full);
    await expect(syncFdaRefusals(withApi(fake), { ...options, events: false })).rejects.toThrow('exceeded 20 pages of 5000 rows');
    expect(fake.calls).toHaveLength(20);
    expect(await total(fdaRefusal)).toBe(0);
    expect(await lastRun()).toMatchObject({ status: 'failed', error: expect.stringContaining('exceeded 20 pages of 5000 rows') });
  }, 60_000);

  it('pages until a short page', async () => {
    const template = JSON.parse(PAGE1).result[0];
    const fake = api((body) => {
      const start = body['start'] as number;
      const size = start === 1 ? 5000 : 3;
      const rows = Array.from({ length: size }, (_, i) => ({ ...template, ShipmentID: `P-${start + i}` }));
      return JSON.stringify({ statuscode: 400, message: 'Success.', resultcount: size, result: rows });
    });
    const result = await syncFdaRefusals(withApi(fake), { ...options, events: false });
    expect(fake.calls.map((c) => JSON.parse(c.options?.body ?? '{}').start)).toEqual([1, 5001]);
    expect(result).toMatchObject({ rowsRead: 5003, rowsInserted: 5003 });
  }, 60_000);

  it('keeps the HTTP status on API errors', async () => {
    const fake = api(() => '<html>Service Unavailable</html>', 503);
    const error = await syncFdaRefusals(withApi(fake), options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceFetchError);
    expect((error as SourceFetchError).status).toBe(503);
    expect(await lastRun()).toMatchObject({ source: 'fda_refusals', status: 'failed' });
    expect(await total(fdaRefusal)).toBe(0);
  });

  it('leaves live tables unchanged when a row is invalid', async () => {
    const page = JSON.parse(PAGE1);
    page.result[5].ShipmentID = null;
    await expect(syncFdaRefusals(withApi(api(() => JSON.stringify(page))), options)).rejects.toThrow(/ShipmentID/);
    expect(await total(fdaRefusal)).toBe(0);
    expect(await lastRun()).toMatchObject({ status: 'failed' });
  });

  describe('classifyRefusal', () => {
    const record = (overrides: Partial<RefusalRecord>) =>
      ({ industryCode: '23', productDesc: 'SESAME SEED PASTE', chargeCodes: [], ...overrides }) as RefusalRecord;

    it('unions the hazards of the charge codes, skipping unknown and unclassified ones', () => {
      const map = new Map<string, number | null>([['9', 400], ['3422', 900], ['1', null]]);
      expect(classifyRefusal(deps.rules, map, record({ chargeCodes: ['9', '3422', '1', '77'] })).hazardIds).toEqual([400, 900]);
    });
    it('falls back to unclassified', () => {
      expect(classifyRefusal(deps.rules, new Map(), record({ chargeCodes: ['1'] })).hazardIds).toEqual([1200]);
    });
  });
});
