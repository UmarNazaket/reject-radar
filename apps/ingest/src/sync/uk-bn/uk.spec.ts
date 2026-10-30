import { changeEvent, notice, prepareTestDatabase, sourceFile, sourceSyncRun, ukBorderNotification } from '@rejectradar/db';
import { count, desc, eq, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SyncDeps } from '../../core/deps';
import { openDb } from '../../core/db';
import { loadRuleSet } from '@rejectradar/taxonomy';
import { listMonthlyCsvResources } from '../../core/source-files';
import { fakeFetcher, fetchResult } from '../../core/test-fetcher';
import { seedSucceededRun } from '../../core/test-sync-run';
import { classifyUk, parseUkCsv, UK_HEADERS, UK_PACKAGE_URL, type UkRow } from './parse';
import { syncUkBn } from './sync';

const fixtureBytes = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name));
const fixture = (name: string) => fixtureBytes(name).toString('utf8');
const PACKAGE = JSON.parse(fixture('package_show.json')) as unknown;
const APRIL_2026 = fixture('April-2026.csv');
const APRIL_2025 = fixtureBytes('BNApril2025.csv');

const TODAY = '2026-10-18';
const URL_2026 = 'https://fsaopendata.blob.core.windows.net/opendatacatalog/April-2026.csv';
const URL_2025 = 'https://fsaopendata.blob.core.windows.net/opendatacatalog/BNApril2025.csv';
const URL_2024 = 'https://fsaopendata.blob.core.windows.net/opendatacatalog/BNDecember2024.csv';
const HEADER = UK_HEADERS.join(',');
const DECEMBER_2024 = `${HEADER}\r\n05/12/2024,India,0910,100 kg,Herbs and spices,Turmeric Powder,Yes,FNAO,Mycotoxins,Mycotoxins,Physical\r\n`;

const row = (overrides: Partial<UkRow> = {}): UkRow => ({
  sourceKey: 'k',
  notifiedOn: '2026-04-01',
  originCountry: 'IN',
  countryName: 'India',
  commodity: null,
  productCategory: null,
  productName: null,
  hazardCategory: null,
  failureType: null,
  reason: null,
  consignmentType: null,
  legislationControlled: null,
  ...overrides,
});

describe('UK border-notification parsing', () => {
  it('lists monthly CSV resources', () => {
    const found = listMonthlyCsvResources(PACKAGE);
    expect(found).toHaveLength(3);
    expect(found.map((r) => r.month)).toEqual(['2024-12', '2025-04', '2026-04']);
    expect(found.find((r) => r.month === '2026-04')?.url).toBe(URL_2026);
  });

  it('parses rows', () => {
    const rows = parseUkCsv(APRIL_2026, '2026-04');
    expect(rows).toHaveLength(71);
    expect(rows[0]).toMatchObject({
      notifiedOn: '2026-04-01',
      originCountry: 'TT',
      productCategory: 'Prepared dishes and snacks',
      productName: 'Cheese Regular',
      commodity: null,
      consignmentType: 'POAO',
    });
    expect(new Set(rows.map((r) => r.sourceKey)).size).toBe(71);
    expect(rows.every((r) => /^[0-9a-f]{40}$/.test(r.sourceKey))).toBe(true);
    // Tabs and padding inside quoted cells are trimmed.
    expect(rows.find((r) => r.productName === 'Passion Fruit')).toMatchObject({ originCountry: 'CO' });
  });

  it('keeps odd bytes as text and skips blank rows', () => {
    const rows = parseUkCsv(APRIL_2025.toString('utf8'), '2025-04');
    expect(rows).toHaveLength(70);
    expect(rows[0]).toMatchObject({ notifiedOn: '2025-04-10', originCountry: 'AR', commodity: '12024200' });
  });

  it('gives identical rows in one file different keys, and the same keys every time', () => {
    const line = '01/04/2026,India,0910,756 kg,Herbs and spices,Ground Ginger,Yes,FNAO,Pesticide residues,Pesticide residues,Physical';
    const twice = parseUkCsv(`${HEADER}\n${line}\n${line}\n`, '2026-04');
    expect(twice).toHaveLength(2);
    expect(twice[0].sourceKey).not.toBe(twice[1].sourceKey);
    expect(parseUkCsv(`${HEADER}\n${line}\n`, '2026-04')[0].sourceKey).toBe(twice[0].sourceKey);
    expect(parseUkCsv(`${HEADER}\n${line}\n`, '2026-05')[0].sourceKey).not.toBe(twice[0].sourceKey);
  });

  it('accepts headers in any case, padded, after a byte-order mark', () => {
    const header = `${String.fromCharCode(0xfeff)} ${UK_HEADERS.join(' , ').toUpperCase()} `;
    const rows = parseUkCsv(`${header}\n01/04/2026,India,,1 kg,Herbs and spices,Ginger,Yes,FNAO,Mycotoxins,Mycotoxins,Physical\n`, '2026-04');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ originCountry: 'IN', productName: 'Ginger' });
  });

  it('treats a literal NA country as not available', () => {
    const rows = parseUkCsv(`${HEADER}\n01/04/2026,NA,,1 kg,Herbs and spices,Ginger,Yes,FNAO,Mycotoxins,Mycotoxins,Physical\n`, '2026-04');
    expect(rows[0].originCountry).toBeNull();
  });

  it('rejects a file with an unknown header', () => {
    expect(() => parseUkCsv(fixture('bad-header.csv'), '2026-04')).toThrow(/Origin/);
    expect(() => parseUkCsv(fixture('bad-header.csv'), '2026-04')).toThrow(/Country/);
  });

  it('rejects a missing header, an empty file and a bad date', () => {
    expect(() => parseUkCsv(HEADER.replace(',Country', ''), '2026-04')).toThrow(/Country/);
    expect(() => parseUkCsv('', '2026-04')).toThrow(/header/i);
    expect(() => parseUkCsv(`${HEADER}\n31/02/2026,India,,,,,,,,,\n`, '2026-04')).toThrow(/31\/02\/2026/);
    expect(() => parseUkCsv(`${HEADER}\n2026-13-01,India,,,,,,,,,\n`, '2026-04')).toThrow(/2026-13-01/);
    expect(() => parseUkCsv(`${HEADER}\n04-01-2026,India,,,,,,,,,\n`, '2026-04')).toThrow(/04-01-2026/);
    expect(() => parseUkCsv(`${HEADER}\n,India,,,,,,,,,\n`, '2026-04')).toThrow(/date/i);
  });

  describe('real files, January 2023 to April 2026', () => {
    const WITHOUT_NET_WEIGHT = UK_HEADERS.filter((name) => name !== 'NetWeight').join(',');

    it('reads the 2023-24 layout: no NetWeight column and ISO dates', () => {
      const rows = parseUkCsv(`${WITHOUT_NET_WEIGHT}\r\n2023-01-05,Venezuela,3048990,Fish & fish products,Not listed,Yes,POAO,Documentary checks,Documentary,NA\r\n`, '2023-01');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ notifiedOn: '2023-01-05', originCountry: 'VE', commodity: '3048990', productName: 'Not listed', reason: 'NA' });
    });

    it('ignores blank header cells after the last column, but not data under them', () => {
      const line = '01/08/2025,India,0910,3 kg,Herbs and spices,Ginger,Yes,FNAO,Mycotoxins,Mycotoxins,Physical';
      expect(parseUkCsv(`${HEADER},,,,\r\n${line},,,,\r\n`, '2025-08')).toHaveLength(1);
      expect(() => parseUkCsv(`${HEADER},,\r\n${line},,stray\r\n`, '2025-08')).toThrow(/row 2.*stray/);
    });

    it('reads a zero-padded day or month (24/011/2024)', () => {
      const [row] = parseUkCsv(`${HEADER}\r\n24/011/2024,Norway,3021400,635 kg,Fish & fish products,Chilled salmon,Yes,POAO,Microbiological contamination,Laboratory,Physical\r\n`, '2024-11');
      expect(row.notifiedOn).toBe('2024-11-24');
    });

    it("reads a date whose month or year is garbled as that day of the file's month (December 2024), with a warning", () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const line = (date: string) => `${HEADER}\r\n${date},Bulgaria,160100,241.5 kg,Meat & meat products,Sausage,Yes,POAO,Microbiological contamination,Laboratory,Physical\r\n`;
        expect(parseUkCsv(line('28/12/82024'), '2024-12')[0].notifiedOn).toBe('2024-12-28');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('28/12/82024'));
        expect(parseUkCsv(line('19/24/2024'), '2024-12')[0].notifiedOn).toBe('2024-12-19');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('19/24/2024'));
        // The part that is not garbled must match the file's month, and the day must exist in it.
        expect(() => parseUkCsv(line('28/11/82024'), '2024-12')).toThrow(/28\/11\/82024/);
        expect(() => parseUkCsv(line('19/24/2023'), '2024-12')).toThrow(/19\/24\/2023/);
        expect(() => parseUkCsv(line('32/12/82024'), '2024-12')).toThrow(/32\/12\/82024/);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe('UK classification', () => {
  let rules: SyncDeps['rules'];
  beforeAll(async () => {
    const handle = openDb(await prepareTestDatabase('ingest_uk_classify'));
    try {
      rules = await loadRuleSet(handle.db);
    } finally {
      await handle.close();
    }
  });

  it('normalises category spelling', () => {
    expect(classifyUk(rules, row({ hazardCategory: 'Docmentary checks' })).hazardIds).toEqual([1100]);
    expect(classifyUk(rules, row({ hazardCategory: 'Documentary Checks' })).hazardIds).toEqual([1100]);
    expect(classifyUk(rules, row({ productCategory: 'Fruits & vegetables' })).commodityId).toBe(600);
    expect(classifyUk(rules, row({ productCategory: 'Fruits and vegetables' })).commodityId).toBe(600);
  });

  it('classifies by HS code before the product category', () => {
    expect(classifyUk(rules, row({ commodity: '0909 3100', productCategory: 'Fruits and vegetables' })).commodityId).toBe(203);
  });
});

describe('UK sync', () => {
  let handle: ReturnType<typeof openDb>;
  let deps: SyncDeps;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_uk'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.delete(changeEvent);
    await handle.db.delete(notice);
    await handle.db.delete(ukBorderNotification);
    await handle.db.delete(sourceFile);
    await handle.db.delete(sourceSyncRun);
    // Not a first load, unless a test deletes this run: events are emitted as asked.
    await seedSucceededRun(handle.db, 'uk_bn');
    const rules = await loadRuleSet(handle.db);
    deps = { db: handle.db, rules, today: () => TODAY, fetcher: fakeFetcher(() => fetchResult('')).fetcher };
  });

  /** Serves the package list and the three monthly files; `files` replaces any of them. */
  const backend = (files: Record<string, string | Buffer> = {}) => {
    const served: Record<string, string | Buffer> = { [URL_2026]: APRIL_2026, [URL_2025]: APRIL_2025, [URL_2024]: DECEMBER_2024, ...files };
    const fake = fakeFetcher((url, options) => {
      if (url === UK_PACKAGE_URL) {
        expect(options?.expect).toBe('json');
        return fetchResult(JSON.stringify(PACKAGE), { contentType: 'application/json', url });
      }
      expect(options?.expect).toBe('csv');
      const body = served[url];
      if (body === undefined) throw new Error(`unexpected request ${url}`);
      return fetchResult(body, { contentType: 'text/csv', url });
    });
    return { ...deps, fetcher: fake.fetcher, calls: fake.calls };
  };
  const lastRun = async () => (await handle.db.select().from(sourceSyncRun).orderBy(desc(sourceSyncRun.id)).limit(1))[0];
  const total = async (table: typeof notice | typeof changeEvent | typeof ukBorderNotification | typeof sourceFile) =>
    Number((await handle.db.select({ n: count() }).from(table))[0].n);
  const options = { events: true };

  /** April 2026 with its second data row removed and one new row added. */
  const changedApril2026 = () => {
    const lines = APRIL_2026.trimEnd().split(/\r?\n/);
    lines.splice(2, 1);
    lines.push('30/04/2026,Brazil,0801,500 kg,Nuts and nut products,Brazil Nuts,Yes,FNAO,Mycotoxins,Mycotoxins,Physical');
    return `${lines.join('\r\n')}\r\n`;
  };

  it('loads all files, notices and events', async () => {
    const b = backend();
    const result = await syncUkBn(b, options);
    expect(b.calls.map((c) => c.url)).toEqual([UK_PACKAGE_URL, URL_2024, URL_2025, URL_2026]);
    expect(result).toMatchObject({ status: 'succeeded', rowsRead: 142, rowsInserted: 142, rowsUpdated: 0, rowsDeleted: 0, eventsEmitted: 142 });
    expect(await total(ukBorderNotification)).toBe(142);
    expect(await total(notice)).toBe(142);
    expect(await total(changeEvent)).toBe(142);
    expect(await total(sourceFile)).toBe(3);
    expect(await lastRun()).toMatchObject({ source: 'uk_bn', status: 'succeeded', origin: UK_PACKAGE_URL, rowsInserted: 142 });

    const files = await handle.db.select().from(sourceFile);
    expect(files.find((f) => f.url === URL_2026)).toMatchObject({ source: 'uk_bn', rows: 71, sha256: fetchResult(APRIL_2026).sha256 });
  });

  it('writes the notice, the event and the typed row', async () => {
    await syncUkBn(backend(), options);
    const [first] = parseUkCsv(APRIL_2026, '2026-04');
    const [n] = await handle.db.select().from(notice).where(eq(notice.sourceKey, first.sourceKey));
    expect(n).toMatchObject({
      source: 'uk_bn',
      noticeType: 'uk_border_notification',
      noticeOn: '2026-04-01',
      originCountry: 'TT',
      productText: 'Cheese Regular',
      firmName: null,
      title: `Prepared dishes and snacks: ${first.hazardCategory} (TT)`,
      url: URL_2026,
    });
    const [e] = await handle.db.select().from(changeEvent).where(eq(changeEvent.sourceKey, first.sourceKey));
    expect(e).toMatchObject({ source: 'uk_bn', kind: 'uk_border_notification', requiresFirm: false, occurredOn: '2026-04-01', originCountry: 'TT', noticeId: n.id });
    const [typed] = await handle.db.select().from(ukBorderNotification).where(eq(ukBorderNotification.sourceKey, first.sourceKey));
    expect(typed).toMatchObject({ notifiedOn: '2026-04-01', originCountry: 'TT', productName: 'Cheese Regular', commodityId: n.commodityId, hazardIds: n.hazardIds });
    expect(n.hazardIds.length).toBeGreaterThan(0);
  });

  it('suppresses events on a first load, then emits them', async () => {
    await handle.db.delete(sourceSyncRun);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = await syncUkBn(backend(), options);
      expect(first).toMatchObject({ status: 'succeeded', rowsInserted: 142, eventsEmitted: 0 });
      expect(warn).toHaveBeenCalledWith('first load of uk_bn: events suppressed');
      expect(await total(changeEvent)).toBe(0);
      const second = await syncUkBn(backend({ [URL_2026]: changedApril2026() }), options);
      expect(second).toMatchObject({ rowsInserted: 1, eventsEmitted: 1 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('emits no events with --no-events', async () => {
    const result = await syncUkBn(backend(), { events: false });
    expect(result).toMatchObject({ rowsInserted: 142, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(0);
    expect(await total(notice)).toBe(142);
  });

  it('skips files already loaded', async () => {
    await syncUkBn(backend(), options);
    const files = await handle.db.select().from(sourceFile);
    const b = backend();
    const again = await syncUkBn(b, options);
    expect(b.calls.map((c) => c.url)).toEqual([UK_PACKAGE_URL, URL_2024, URL_2025, URL_2026]);
    expect(again).toMatchObject({ rowsRead: 0, rowsInserted: 0, rowsUpdated: 0, rowsDeleted: 0, eventsEmitted: 0 });
    expect(await handle.db.select().from(sourceFile)).toEqual(files);
  });

  it('reloads a changed file', async () => {
    await syncUkBn(backend(), options);
    const before = parseUkCsv(APRIL_2026, '2026-04');
    const removed = before[1].sourceKey;

    const result = await syncUkBn(backend({ [URL_2026]: changedApril2026() }), options);
    expect(result).toMatchObject({ rowsRead: 71, rowsInserted: 1, rowsUpdated: 0, rowsDeleted: 1, eventsEmitted: 1 });
    expect(await total(ukBorderNotification)).toBe(142);
    expect(await total(notice)).toBe(142);
    expect(await handle.db.select().from(notice).where(eq(notice.sourceKey, removed))).toHaveLength(0);
    expect(await handle.db.select().from(ukBorderNotification).where(eq(ukBorderNotification.sourceKey, removed))).toHaveLength(0);
    // The removed row's earlier event stays, without its notice.
    const [kept] = await handle.db.select().from(changeEvent).where(eq(changeEvent.sourceKey, removed));
    expect(kept.noticeId).toBeNull();
    expect(await total(changeEvent)).toBe(143);

    const [file] = await handle.db.select().from(sourceFile).where(eq(sourceFile.url, URL_2026));
    expect(file.sha256).toBe(fetchResult(changedApril2026()).sha256);
    expect(file.rows).toBe(71);
  });

  /** April 2026 with one cell of its second data row (Jamaica, Mango Peach Drink) replaced. */
  const editedApril2026 = (from: string, to: string) => {
    const lines = APRIL_2026.split('\n');
    expect(lines[2]).toContain(from);
    lines[2] = lines[2].replace(from, to);
    return lines.join('\n');
  };

  it('updates a corrected row in a changed file in place, with no event', async () => {
    await syncUkBn(backend(), options);
    const before = parseUkCsv(APRIL_2026, '2026-04')[1];
    const [oldNotice] = await handle.db.select().from(notice).where(eq(notice.sourceKey, before.sourceKey));
    const events = await total(changeEvent);

    const corrected = editedApril2026(',Composition,', ',Microbiological contamination,');
    const after = parseUkCsv(corrected, '2026-04')[1];
    expect(after.sourceKey).not.toBe(before.sourceKey);
    const result = await syncUkBn(backend({ [URL_2026]: corrected }), options);
    expect(result).toMatchObject({ rowsRead: 71, rowsInserted: 0, rowsUpdated: 1, rowsDeleted: 0, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(events);
    expect(await total(ukBorderNotification)).toBe(142);
    expect(await total(notice)).toBe(142);
    // The row and its notice moved to the new key; the notice keeps its id, so its event still points at it.
    expect(await handle.db.select().from(ukBorderNotification).where(eq(ukBorderNotification.sourceKey, before.sourceKey))).toHaveLength(0);
    const [typed] = await handle.db.select().from(ukBorderNotification).where(eq(ukBorderNotification.sourceKey, after.sourceKey));
    expect(typed.hazardCategory).toBe('Microbiological contamination');
    const [moved] = await handle.db.select().from(notice).where(eq(notice.sourceKey, after.sourceKey));
    expect(moved.id).toBe(oldNotice.id);
    expect(moved.title).toContain('Microbiological contamination');
    const [event] = await handle.db.select().from(changeEvent).where(eq(changeEvent.noticeId, oldNotice.id));
    expect(event).toBeDefined();
  });

  it('moves the events of a corrected row to its new key', async () => {
    await syncUkBn(backend(), options);
    const before = parseUkCsv(APRIL_2026, '2026-04')[1];
    const corrected = editedApril2026(',Composition,', ',Microbiological contamination,');
    const after = parseUkCsv(corrected, '2026-04')[1];

    await syncUkBn(backend({ [URL_2026]: corrected }), options);

    const keys = await handle.db.select({ source: changeEvent.source, sourceKey: changeEvent.sourceKey }).from(changeEvent).where(inArray(changeEvent.sourceKey, [before.sourceKey, after.sourceKey]));
    expect(keys).toEqual([{ source: 'uk_bn', sourceKey: after.sourceKey }]);
  });

  it('pairs a corrected row on the country as the file names it, not on its stored code', async () => {
    await syncUkBn(backend(), options);
    const before = parseUkCsv(APRIL_2026, '2026-04')[1];
    const [oldNotice] = await handle.db.select().from(notice).where(eq(notice.sourceKey, before.sourceKey));
    const events = await total(changeEvent);
    // As if the codes were stored under an earlier country-alias table: phase 3 may map names to other codes.
    await handle.db.update(notice).set({ originCountry: 'ZZ' });
    await handle.db.update(ukBorderNotification).set({ originCountry: 'ZZ' });

    const corrected = editedApril2026(',Composition,', ',Microbiological contamination,');
    const result = await syncUkBn(backend({ [URL_2026]: corrected }), options);
    expect(result).toMatchObject({ rowsInserted: 0, rowsDeleted: 0, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(events);
    const after = parseUkCsv(corrected, '2026-04')[1];
    const [moved] = await handle.db.select().from(notice).where(eq(notice.sourceKey, after.sourceKey));
    expect(moved).toMatchObject({ id: oldNotice.id, originCountry: 'JM' });
    const [typed] = await handle.db.select().from(ukBorderNotification).where(eq(ukBorderNotification.sourceKey, after.sourceKey));
    expect(typed).toMatchObject({ originCountry: 'JM', countryName: 'Jamaica' });
  });

  it('counts a correction of an unstored value (net weight) as one update', async () => {
    await syncUkBn(backend(), options);
    const result = await syncUkBn(backend({ [URL_2026]: editedApril2026(',238 kg,', ',240 kg,') }), options);
    expect(result).toMatchObject({ rowsInserted: 0, rowsUpdated: 1, rowsDeleted: 0, eventsEmitted: 0 });
  });

  it('treats a row whose product changed as a new row, with an event', async () => {
    await syncUkBn(backend(), options);
    const result = await syncUkBn(backend({ [URL_2026]: editedApril2026(',Mango Peach Drink,', ',Guava Drink,') }), options);
    expect(result).toMatchObject({ rowsInserted: 1, rowsUpdated: 0, rowsDeleted: 1, eventsEmitted: 1 });
  });

  it('emits events for every row of a file never loaded before', async () => {
    await syncUkBn(backend({ [URL_2026]: `${HEADER}\r\n` }), options);
    const result = await syncUkBn(backend(), options);
    expect(result).toMatchObject({ rowsInserted: 71, rowsUpdated: 0, rowsDeleted: 0, eventsEmitted: 71 });
  });

  it('leaves other files alone when one changes', async () => {
    await syncUkBn(backend(), options);
    const dec = await handle.db.select().from(ukBorderNotification).where(eq(ukBorderNotification.notifiedOn, '2024-12-05'));
    expect(dec).toHaveLength(1);
    await syncUkBn(backend({ [URL_2026]: changedApril2026() }), options);
    expect(await handle.db.select().from(ukBorderNotification).where(eq(ukBorderNotification.notifiedOn, '2024-12-05'))).toEqual(dec);
    expect(await total(sourceFile)).toBe(3);
  });

  it('decodes a Windows-1252 file (most 2024-26 files are)', async () => {
    const csv = `${HEADER}\r\n01/04/2026,Türkiye,0802,3 kg,Nuts,Crème de pistache,Yes,FNAO,Documentary checks,Documentary,Documentary\r\n`;
    await syncUkBn(backend({ [URL_2026]: Buffer.from(csv, 'latin1') }), options);
    const [row] = await handle.db.select().from(ukBorderNotification).where(eq(ukBorderNotification.notifiedOn, '2026-04-01'));
    expect(row).toMatchObject({ originCountry: 'TR', productName: 'Crème de pistache' });
  });

  it('writes nothing when a file has an unknown header', async () => {
    await expect(syncUkBn(backend({ [URL_2026]: fixture('bad-header.csv') }), options)).rejects.toThrow(/Origin/);
    expect(await total(ukBorderNotification)).toBe(0);
    expect(await total(notice)).toBe(0);
    expect(await total(sourceFile)).toBe(0);
    expect(await lastRun()).toMatchObject({ status: 'failed', error: expect.stringContaining('Origin') });
  });

  it('is idempotent', async () => {
    await syncUkBn(backend(), options);
    const rows = await handle.db.select().from(ukBorderNotification);
    const notices = await handle.db.select().from(notice);
    const again = await syncUkBn(backend(), options);
    expect(again).toMatchObject({ rowsInserted: 0, rowsUpdated: 0, rowsDeleted: 0, eventsEmitted: 0 });
    expect(await handle.db.select().from(ukBorderNotification)).toEqual(rows);
    expect(await handle.db.select().from(notice)).toEqual(notices);
  });
});
