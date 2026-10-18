import { auFailingFood, changeEvent, notice, prepareTestDatabase, sourceFile, sourceSyncRun } from '@rejectradar/db';
import { count, desc, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SyncDeps } from '../../core/deps';
import { openDb } from '../../core/db';
import { loadRuleSet } from '../../core/rules';
import { listMonthlyCsvResources } from '../../core/source-files';
import { fakeFetcher, fetchResult } from '../../core/test-fetcher';
import { seedSucceededRun } from '../../core/test-sync-run';
import { AU_HEADER_ALIASES, AU_REQUIRED, classifyAu, decodeAuCsv, parseAuCsv, type AuRecord } from './parse';
import { AU_PACKAGE_URL, syncAuIfis } from './sync';

const fixtureBytes = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name));
const fixture = (name: string) => decodeAuCsv(fixtureBytes(name));
const PACKAGE = JSON.parse(fixtureBytes('package_show.json').toString('utf8')) as unknown;

const TODAY = '2026-10-18';
const URL_MAY = 'https://data.gov.au/data/dataset/e56bcf6a-7bfb-4cb5-8c65-8ec18bd4b7d5/resource/202d9e34-4e6d-4f6b-bacd-5731aa59e30d/download/may-2026-ifis-failing-food-report.csv';
const URL_JUNE = 'https://data.gov.au/data/dataset/e56bcf6a-7bfb-4cb5-8c65-8ec18bd4b7d5/resource/b0950e17-c23b-4d8e-8122-4397459b4cec/download/failing-food-report-june-2026.csv';
const URL_JULY = 'https://data.gov.au/data/dataset/e56bcf6a-7bfb-4cb5-8c65-8ec18bd4b7d5/resource/a75154c8-1913-4a90-a498-ac78b02379c0/download/july-2026-ifis-failing-food-report.csv';
const HEADER = 'Date of fail,Product description,County of origin,Producer Name,Test applied / reason for fail,Results / Units,Reference criteria,Food category';

const record = (overrides: Partial<AuRecord> = {}): AuRecord => ({
  sourceKey: 'k',
  reportMonth: '2026-07-01',
  failedOn: '2026-07-01',
  productDesc: 'Product',
  countryCode: 'IN',
  producerName: 'Producer',
  nameNorm: 'producer',
  testApplied: 'Test',
  reason: 'Test',
  resultText: null,
  holdingOrderMatch: null,
  scheme: null,
  ...overrides,
});

describe('Australian failing-food parsing', () => {
  it('lists the monthly CSV resources', () => {
    const found = listMonthlyCsvResources(PACKAGE);
    expect(found.map((r) => r.month)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(found.map((r) => r.url)).toEqual([URL_MAY, URL_JUNE, URL_JULY]);
  });

  it('keeps the header aliases from the brief', () => {
    expect(AU_HEADER_ALIASES.country).toEqual(['county of origin', 'country of origin']);
    expect(AU_REQUIRED).toEqual(['failedOn', 'product', 'country', 'producer', 'test']);
  });

  it('folds continuation rows', () => {
    const july = parseAuCsv(fixture('july-2026.csv'), '2026-07-01');
    expect(july).toHaveLength(22);
    const scampi = july.find((r) => r.productDesc === 'Frozen cooked scampi');
    expect(scampi).toMatchObject({
      failedOn: '2026-07-06',
      testApplied: 'Nitrofurans:; Nitrofurazone (SEM) not permitted in this food',
      reason: 'Nitrofurans:; Nitrofurazone (SEM) not permitted in this food',
      resultText: '0.002mg/kg',
    });
    // Continuation rows that carry only a result.
    expect(july.find((r) => r.productDesc === 'Maldive fish chips')).toMatchObject({
      testApplied: 'Histamine detected in excess of level permitted',
      resultText: '447 mg/kg,; 502 mg/kg,; 497 mg/kg',
    });

    const may = parseAuCsv(fixture('may-2026.csv'), '2026-05-01');
    expect(may).toHaveLength(44);
    const persimmon = may.find((r) => r.productDesc === 'Dried persimmon');
    expect(persimmon?.testApplied.match(/; /g)).toHaveLength(3);
    expect(persimmon?.resultText).toBe('0.17 mg/kg; 0.21 mg/kg; 0.05 mg/kg');
    // A record followed by two continuation rows holds three tests.
    expect(may.filter((r) => r.testApplied.match(/; /g)?.length === 2).length).toBeGreaterThan(0);
  });

  it('accepts June 2026 headers', () => {
    const csv = fixture('june-2026.csv');
    expect(csv.split('\n')[0].trimEnd()).toBe('Date of Fail ,Product Description,County Of Origin,Producer Name,Reason for Fail,Results,Reference criteria,Referral Category');
    expect(csv.split(/\r?\n/).filter((line) => /^,*$/.test(line) && line !== '')).toHaveLength(8);
    const june = parseAuCsv(csv, '2026-06-01');
    expect(june).toHaveLength(31);
    expect(june[0]).toMatchObject({ failedOn: '2026-06-01', productDesc: 'Gorgonzola cheese', countryCode: 'IT', scheme: 'risk', reportMonth: '2026-06-01' });
  });

  it('fills the producer name for every record', () => {
    for (const [file, month, expected] of [['july-2026.csv', '2026-07-01', 22], ['june-2026.csv', '2026-06-01', 31], ['may-2026.csv', '2026-05-01', 44]] as const) {
      const records = parseAuCsv(fixture(file), month);
      expect(records).toHaveLength(expected);
      expect(records.filter((r) => r.producerName === null)).toHaveLength(0);
      expect(records.every((r) => r.nameNorm !== '')).toBe(true);
    }
  });

  it('rejects a file whose required column is missing', () => {
    expect(() => parseAuCsv(fixture('missing-producer-column.csv'), '2026-07-01')).toThrow(/producer/);
  });

  it.each([
    ['2022-23 (Reference)', 'Date of fail,Product description,Country of origin,Producer name,Test applied / reason for fail,Results / Units,Reference,Food category'],
    ['March 2022 (no spaces around the slash)', 'Date of fail,Product description,Country of origin,Producer name,Test applied/ reason for fail,Results/Units,Reference,Food category'],
    ['July 2024 (typo)', 'Date of Fail,Product Description,County Of Origin,Producer Name,Test applied / Reason for Fail,Results/Units,Reference Critera,Food category'],
    ['October 2024 (Standard)', 'Date of Fail,Product Description,County Of Origin,Producer Name,Reason for Fail,Results,Standard,Referral Category'],
  ])('accepts the live header spelling of %s', (_, header) => {
    const [first] = parseAuCsv(`${header}\n5/07/2026,Chilli powder,India,Mr Agro,Salmonella detected,Detected/125g,FSC 1.6.1,Risk\n`, '2026-07-01');
    expect(first).toMatchObject({ productDesc: 'Chilli powder', testApplied: 'Salmonella detected', resultText: 'Detected/125g', scheme: 'risk' });
  });

  it('rejects an unknown header, a repeated header and an empty file', () => {
    expect(() => parseAuCsv(HEADER.replace('Reference criteria', 'Surprise column'), '2026-07-01')).toThrow(/Surprise column/);
    expect(() => parseAuCsv(`${HEADER},Producer name`, '2026-07-01')).toThrow(/Producer name/);
    expect(() => parseAuCsv('', '2026-07-01')).toThrow(/header/i);
  });

  it('sets scheme and holding order', () => {
    const july = parseAuCsv(fixture('july-2026.csv'), '2026-07-01');
    expect(july[0]).toMatchObject({ productDesc: 'Throat drops', scheme: 'surveillance', holdingOrderMatch: true });
    expect(july[1]).toMatchObject({ productDesc: 'Cremoso al tartufo cheese', scheme: 'risk', holdingOrderMatch: null });
    const may = parseAuCsv(fixture('may-2026.csv'), '2026-05-01');
    expect(may.find((r) => r.productDesc === 'Frozen strawberries')).toMatchObject({ scheme: 'risk', holdingOrderMatch: true });
    const june = parseAuCsv(fixture('june-2026.csv'), '2026-06-01');
    // June 2026 writes a bare `HOM` (holding-order match) with no scheme.
    expect(june.find((r) => r.productDesc === 'Super c sweets strawberry')).toMatchObject({ scheme: null, holdingOrderMatch: true });
    expect(june.filter((r) => r.productDesc === 'Jackfruit')).toEqual(
      expect.arrayContaining([expect.objectContaining({ scheme: null, holdingOrderMatch: true }), expect.objectContaining({ scheme: 'surveillance', holdingOrderMatch: true })]),
    );
  });

  it('gives identical-looking records different keys, and the same keys every time', () => {
    const june = parseAuCsv(fixture('june-2026.csv'), '2026-06-01');
    expect(new Set(june.map((r) => r.sourceKey)).size).toBe(31);
    expect(june.every((r) => /^[0-9a-f]{40}$/.test(r.sourceKey))).toBe(true);
    const brittle = june.filter((r) => r.productDesc === 'Peanut brittle');
    expect(brittle).toHaveLength(2);
    expect(brittle[0].sourceKey).not.toBe(brittle[1].sourceKey);
    expect(parseAuCsv(fixture('june-2026.csv'), '2026-06-01').map((r) => r.sourceKey)).toEqual(june.map((r) => r.sourceKey));
    expect(parseAuCsv(fixture('june-2026.csv'), '2026-07-01')[0].sourceKey).not.toBe(june[0].sourceKey);
  });

  it("keeps a record's key when only its results change", () => {
    const line = '1/07/2026,Chilli powder,India,Mr Agro,Salmonella detected,Detected/125g,FSC 1.6.1,Risk';
    const a = parseAuCsv(`${HEADER}\n${line}\n`, '2026-07-01')[0];
    const b = parseAuCsv(`${HEADER}\n${line.replace('Detected/125g', 'Detected / 25g')}\n`, '2026-07-01')[0];
    expect(b.sourceKey).toBe(a.sourceKey);
    expect(b.resultText).toBe('Detected / 25g');
  });

  it('reads dates as D/MM/YYYY and a literal NA country as not available', () => {
    const [first] = parseAuCsv(`${HEADER}\n5/07/2026,Chilli powder,NA,Mr Agro,Salmonella detected,,,\n`, '2026-07-01');
    expect(first).toMatchObject({ failedOn: '2026-07-05', countryCode: null, resultText: null, scheme: null, holdingOrderMatch: null });
    expect(() => parseAuCsv(`${HEADER}\n31/02/2026,Chilli,India,Mr Agro,Salmonella detected,,,\n`, '2026-07-01')).toThrow(/31\/02\/2026/);
    expect(() => parseAuCsv(`${HEADER}\n2026-07-01,Chilli,India,Mr Agro,Salmonella detected,,,\n`, '2026-07-01')).toThrow(/2026-07-01/);
  });

  it('leaves the producer null when none is named', () => {
    const [first] = parseAuCsv(`${HEADER}\n5/07/2026,Chilli powder,India,,Salmonella detected,,,\n`, '2026-07-01');
    expect(first).toMatchObject({ producerName: null, nameNorm: '' });
  });

  it('rejects a continuation row with nothing above it and a record with no product', () => {
    expect(() => parseAuCsv(`${HEADER}\n,,,,Salmonella detected,,,\n`, '2026-07-01')).toThrow(/row 2/);
    expect(() => parseAuCsv(`${HEADER}\n5/07/2026,,India,Mr Agro,Salmonella detected,,,\n`, '2026-07-01')).toThrow(/product/);
  });

  it('decodes UTF-8 and falls back to Windows-1252', () => {
    expect(decodeAuCsv(Buffer.from('Café – x', 'utf8'))).toBe('Café – x');
    expect(decodeAuCsv(Buffer.from([0x56, 0x96, 0x20, 0xe9]))).toBe('V– é');
  });
});

describe('Australian classification', () => {
  let rules: SyncDeps['rules'];
  beforeAll(async () => {
    const handle = openDb(await prepareTestDatabase('ingest_au_classify'));
    try {
      rules = await loadRuleSet(handle.db);
    } finally {
      await handle.close();
    }
  });

  it('classifies the product and each test separately', () => {
    expect(classifyAu(rules, record({ productDesc: 'Chilli powder', testApplied: 'Salmonella detected', reason: 'Salmonella detected' }))).toEqual({
      commodityId: 201,
      hazardIds: [400],
    });
    expect(
      classifyAu(rules, record({ productDesc: 'Peanut brittle', testApplied: 'Aflatoxin detected in excess of level permitted; Carbendazim not permitted in this food' })),
    ).toEqual({ commodityId: 302, hazardIds: [100, 300] });
  });

  it('falls back to unclassified', () => {
    expect(classifyAu(rules, record({ productDesc: 'Mystery', testApplied: 'Something odd' })).hazardIds).toEqual([1200]);
  });
});

describe('Australian sync', () => {
  let handle: ReturnType<typeof openDb>;
  let deps: SyncDeps;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_au'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.delete(changeEvent);
    await handle.db.delete(notice);
    await handle.db.delete(auFailingFood);
    await handle.db.delete(sourceFile);
    await handle.db.delete(sourceSyncRun);
    // Not a first load, unless a test deletes this run: events are emitted as asked.
    await seedSucceededRun(handle.db, 'au_ifis');
    const rules = await loadRuleSet(handle.db);
    deps = { db: handle.db, rules, today: () => TODAY, fetcher: fakeFetcher(() => fetchResult('')).fetcher };
  });

  /** Serves the package list and the three monthly files; `files` replaces any of them. */
  const backend = (files: Record<string, string | Buffer> = {}, failing: string[] = []) => {
    const served: Record<string, string | Buffer> = {
      [URL_MAY]: fixtureBytes('may-2026.csv'),
      [URL_JUNE]: fixtureBytes('june-2026.csv'),
      [URL_JULY]: fixtureBytes('july-2026.csv'),
      ...files,
    };
    const fake = fakeFetcher((url, options) => {
      if (url === AU_PACKAGE_URL) {
        expect(options?.expect).toBe('json');
        return fetchResult(JSON.stringify(PACKAGE), { contentType: 'application/json', url });
      }
      expect(options?.expect).toBe('csv');
      if (failing.includes(url)) throw new Error(`download failed: ${url}`);
      const body = served[url];
      if (body === undefined) throw new Error(`unexpected request ${url}`);
      return fetchResult(body, { contentType: 'text/csv', url });
    });
    return { ...deps, fetcher: fake.fetcher, calls: fake.calls };
  };
  const lastRun = async () => (await handle.db.select().from(sourceSyncRun).orderBy(desc(sourceSyncRun.id)).limit(1))[0];
  const total = async (table: typeof notice | typeof changeEvent | typeof auFailingFood | typeof sourceFile) =>
    Number((await handle.db.select({ n: count() }).from(table))[0].n);
  const options = { events: true };

  /** July 2026 with its second record removed and one new record added. */
  const changedJuly = () => {
    const lines = fixture('july-2026.csv').trimEnd().split(/\r?\n/);
    lines.splice(2, 1);
    lines.push('31/07/2026,Dried mango,Philippines,Profood International,Sulphur dioxide detected in excess of level permitted,2300 mg/kg,FSC 1.3.1,Risk');
    return `${lines.join('\r\n')}\r\n`;
  };

  it('loads all files, notices and events', async () => {
    const b = backend();
    const result = await syncAuIfis(b, options);
    expect(b.calls.map((c) => c.url)).toEqual([AU_PACKAGE_URL, URL_MAY, URL_JUNE, URL_JULY]);
    expect(result).toMatchObject({ status: 'succeeded', rowsRead: 97, rowsInserted: 97, rowsUpdated: 0, rowsDeleted: 0, eventsEmitted: 97 });
    expect(await total(auFailingFood)).toBe(97);
    expect(await total(notice)).toBe(97);
    expect(await total(changeEvent)).toBe(97);
    expect(await total(sourceFile)).toBe(3);
    expect(await lastRun()).toMatchObject({ source: 'au_ifis', status: 'succeeded', origin: AU_PACKAGE_URL, rowsInserted: 97 });
    const files = await handle.db.select().from(sourceFile);
    expect(files.find((f) => f.url === URL_JULY)).toMatchObject({ source: 'au_ifis', rows: 22, sha256: fetchResult(fixtureBytes('july-2026.csv')).sha256 });
  });

  it('writes the notice, the event and the typed row', async () => {
    await syncAuIfis(backend(), options);
    const [first] = parseAuCsv(fixture('july-2026.csv'), '2026-07-01');
    const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, first.sourceKey));
    expect(n).toMatchObject({
      source: 'au_ifis',
      noticeType: 'au_failed_test',
      noticeOn: '2026-07-01',
      originCountry: 'JP',
      productText: 'Throat drops',
      firmName: 'Kanro Co., Ltd',
      title: 'Throat drops failed: Composition: Vitamin C not permitted in this food.',
      url: URL_JULY,
      destination: 'AU',
    });
    const [e] = await handle.db.select().from(changeEvent).where(eq(changeEvent.sourceKey, first.sourceKey));
    expect(e).toMatchObject({ source: 'au_ifis', kind: 'au_failed_test', severity: 'high', requiresFirm: true, occurredOn: '2026-07-01', originCountry: 'JP', noticeId: n.id });
    const [typed] = await handle.db.select().from(auFailingFood).where(eq(auFailingFood.sourceKey, first.sourceKey));
    expect(typed).toMatchObject({
      reportMonth: '2026-07-01',
      failedOn: '2026-07-01',
      productDesc: 'Throat drops',
      countryCode: 'JP',
      producerName: 'Kanro Co., Ltd',
      holdingOrderMatch: true,
      scheme: 'surveillance',
      commodityId: n.commodityId,
      hazardIds: n.hazardIds,
      firmId: null,
    });
    expect(typed.nameNorm).not.toBe('');
    expect(n.hazardIds.length).toBeGreaterThan(0);
  });

  it('uses the first test in the title of a record with several', async () => {
    await syncAuIfis(backend(), options);
    const [n] = await handle.db.select().from(notice).where(eq(notice.productText, 'Frozen cooked scampi'));
    expect(n.title).toBe('Frozen cooked scampi failed: Nitrofurans:');
  });

  it('requires a firm only when a producer is named', async () => {
    const csv = `${HEADER}\n5/07/2026,Unnamed chilli,India,,Salmonella detected,Detected/125g,FSC 1.6.1,Risk\n6/07/2026,Chilli flakes,India,Mr Agro,Salmonella detected,Detected/125g,FSC 1.6.1,Risk\n`;
    await syncAuIfis(backend({ [URL_JULY]: csv }), options);
    const named = await handle.db.select().from(changeEvent).where(eq(changeEvent.occurredOn, '2026-07-06'));
    const unnamed = await handle.db.select().from(changeEvent).where(eq(changeEvent.occurredOn, '2026-07-05'));
    expect(named).toHaveLength(1);
    expect(named[0].requiresFirm).toBe(true);
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0].requiresFirm).toBe(false);
    const [n] = await handle.db.select().from(notice).where(eq(notice.productText, 'Unnamed chilli'));
    expect(n.firmName).toBeNull();
  });

  it('suppresses events on a first load, then emits them', async () => {
    await handle.db.delete(sourceSyncRun);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = await syncAuIfis(backend(), options);
      expect(first).toMatchObject({ status: 'succeeded', rowsInserted: 97, eventsEmitted: 0 });
      expect(warn).toHaveBeenCalledWith('first load of au_ifis: events suppressed');
      expect(await total(changeEvent)).toBe(0);
      const second = await syncAuIfis(backend({ [URL_JULY]: changedJuly() }), options);
      expect(second).toMatchObject({ rowsInserted: 1, eventsEmitted: 1 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('emits no events with --no-events', async () => {
    const result = await syncAuIfis(backend(), { events: false });
    expect(result).toMatchObject({ rowsInserted: 97, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(0);
    expect(await total(notice)).toBe(97);
  });

  it('skips files already loaded', async () => {
    await syncAuIfis(backend(), options);
    const files = await handle.db.select().from(sourceFile);
    const b = backend();
    const again = await syncAuIfis(b, options);
    expect(b.calls.map((c) => c.url)).toEqual([AU_PACKAGE_URL, URL_MAY, URL_JUNE, URL_JULY]);
    expect(again).toMatchObject({ rowsRead: 0, rowsInserted: 0, rowsUpdated: 0, rowsDeleted: 0, eventsEmitted: 0 });
    expect(await handle.db.select().from(sourceFile)).toEqual(files);
  });

  it('reloads a changed file and leaves the others alone', async () => {
    await syncAuIfis(backend(), options);
    const removed = parseAuCsv(fixture('july-2026.csv'), '2026-07-01')[1].sourceKey;
    const may = await handle.db.select().from(auFailingFood).where(eq(auFailingFood.reportMonth, '2026-05-01'));

    const result = await syncAuIfis(backend({ [URL_JULY]: changedJuly() }), options);
    expect(result).toMatchObject({ rowsRead: 22, rowsInserted: 1, rowsUpdated: 0, rowsDeleted: 1, eventsEmitted: 1 });
    expect(await total(auFailingFood)).toBe(97);
    expect(await total(notice)).toBe(97);
    expect(await handle.db.select().from(notice).where(eq(notice.sourceKey, removed))).toHaveLength(0);
    expect(await handle.db.select().from(auFailingFood).where(eq(auFailingFood.sourceKey, removed))).toHaveLength(0);
    // The removed record's earlier event stays, without its notice.
    const [kept] = await handle.db.select().from(changeEvent).where(eq(changeEvent.sourceKey, removed));
    expect(kept.noticeId).toBeNull();
    expect(await total(changeEvent)).toBe(98);
    expect(await handle.db.select().from(auFailingFood).where(eq(auFailingFood.reportMonth, '2026-05-01'))).toEqual(may);
    expect(await total(sourceFile)).toBe(3);
    const [file] = await handle.db.select().from(sourceFile).where(eq(sourceFile.url, URL_JULY));
    expect(file.sha256).toBe(fetchResult(changedJuly()).sha256);
    expect(file.rows).toBe(22);
  });

  /** July 2026 with one cell of its second record (Cremoso al tartufo cheese) replaced. */
  const editedJuly = (from: string, to: string) => {
    const lines = fixture('july-2026.csv').split('\n');
    expect(lines[2]).toContain(from);
    lines[2] = lines[2].replace(from, to);
    return lines.join('\n');
  };

  it('updates a corrected record in a changed file in place, with no event', async () => {
    await syncAuIfis(backend(), options);
    const before = parseAuCsv(fixture('july-2026.csv'), '2026-07-01')[1];
    const [oldNotice] = await handle.db.select().from(notice).where(eq(notice.sourceKey, before.sourceKey));
    const events = await total(changeEvent);

    const corrected = editedJuly(',Listeria monocytogenes detected,', ',Listeria monocytogenes detected in excess of level permitted,');
    const after = parseAuCsv(corrected, '2026-07-01')[1];
    expect(after.sourceKey).not.toBe(before.sourceKey);
    const result = await syncAuIfis(backend({ [URL_JULY]: corrected }), options);
    expect(result).toMatchObject({ rowsRead: 22, rowsInserted: 0, rowsUpdated: 1, rowsDeleted: 0, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(events);
    expect(await total(auFailingFood)).toBe(97);
    expect(await handle.db.select().from(auFailingFood).where(eq(auFailingFood.sourceKey, before.sourceKey))).toHaveLength(0);
    const [typed] = await handle.db.select().from(auFailingFood).where(eq(auFailingFood.sourceKey, after.sourceKey));
    expect(typed.testApplied).toBe('Listeria monocytogenes detected in excess of level permitted');
    const [moved] = await handle.db.select().from(notice).where(eq(notice.sourceKey, after.sourceKey));
    expect(moved.id).toBe(oldNotice.id);
  });

  it('treats a record whose producer changed as a new record, with an event', async () => {
    await syncAuIfis(backend(), options);
    const result = await syncAuIfis(backend({ [URL_JULY]: editedJuly(',Latteria Moro Di Moro Sergio,', ',Another Dairy,') }), options);
    expect(result).toMatchObject({ rowsInserted: 1, rowsUpdated: 0, rowsDeleted: 1, eventsEmitted: 1 });
  });

  it('writes nothing when a file lacks a required column', async () => {
    await expect(syncAuIfis(backend({ [URL_JULY]: fixtureBytes('missing-producer-column.csv') }), options)).rejects.toThrow(/producer/);
    expect(await total(auFailingFood)).toBe(0);
    expect(await total(notice)).toBe(0);
    expect(await total(sourceFile)).toBe(0);
    expect(await lastRun()).toMatchObject({ status: 'failed', error: expect.stringContaining('producer') });
  });

  it('fails the whole run when a download fails', async () => {
    await expect(syncAuIfis(backend({}, [URL_JUNE]), options)).rejects.toThrow(/download failed/);
    expect(await total(auFailingFood)).toBe(0);
    expect(await total(sourceFile)).toBe(0);
    expect(await lastRun()).toMatchObject({ status: 'failed' });
  });

  it('is idempotent', async () => {
    await syncAuIfis(backend(), options);
    const rows = await handle.db.select().from(auFailingFood);
    const notices = await handle.db.select().from(notice);
    const again = await syncAuIfis(backend(), options);
    expect(again).toMatchObject({ rowsInserted: 0, rowsUpdated: 0, rowsDeleted: 0, eventsEmitted: 0 });
    expect(await handle.db.select().from(auFailingFood)).toEqual(rows);
    expect(await handle.db.select().from(notice)).toEqual(notices);
  });
});
