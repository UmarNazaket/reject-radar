import { prepareTestDatabase, sourceFile } from '@rejectradar/db';
import { openDb } from './db';
import { listMonthlyCsvResources, loadedFile, recordFile } from './source-files';

const resource = (name: string, url: string, format = 'CSV') => ({ name, url, format });
const pkg = (resources: unknown[]) => ({ success: true, result: { resources } });

describe('listMonthlyCsvResources', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('keeps CSV resources whose name holds a month and a year', () => {
    const found = listMonthlyCsvResources(
      pkg([
        resource('Border Notifications - Supporting Documentation', 'https://x.test/doc.pdf', 'PDF'),
        resource('Border Notifications - April 2026', 'https://x.test/a.csv'),
        resource('Border Notifications - december 2024', 'https://x.test/d.csv', '.csv'),
        resource('Border Notifications - May 2025', 'https://x.test/m.pdf', 'PDF'),
        resource('Border Notifications - Sept 2025', 'https://x.test/s.csv'),
      ]),
    );
    expect(found).toEqual([
      { name: 'Border Notifications - december 2024', url: 'https://x.test/d.csv', month: '2024-12' },
      { name: 'Border Notifications - April 2026', url: 'https://x.test/a.csv', month: '2026-04' },
    ]);
  });

  it('warns about each CSV resource it skips for want of a month and year, and counts them', () => {
    listMonthlyCsvResources(
      pkg([
        resource('Border Notifications - Supporting Documentation', 'https://x.test/doc.pdf', 'PDF'),
        resource('Border Notifications - April 2026', 'https://x.test/a.csv'),
        resource('Border Notifications - Sept 2025', 'https://x.test/s.csv'),
        resource('All notifications', 'https://x.test/all.csv', 'csv'),
      ]),
    );
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'CKAN CSV resource skipped, no "Month YYYY" in its name: "Border Notifications - Sept 2025" (https://x.test/s.csv)',
      'CKAN CSV resource skipped, no "Month YYYY" in its name: "All notifications" (https://x.test/all.csv)',
      '2 CKAN CSV resources skipped for want of a month and year in the name',
    ]);
  });

  it('warns about nothing when every CSV resource is monthly', () => {
    listMonthlyCsvResources(pkg([resource('Border Notifications - April 2026', 'https://x.test/a.csv')]));
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails on a response that is not a CKAN package', () => {
    expect(() => listMonthlyCsvResources({ success: false })).toThrow(/resources/);
    expect(() => listMonthlyCsvResources(null)).toThrow(/resources/);
    expect(() => listMonthlyCsvResources({ result: { resources: 'nope' } })).toThrow(/resources/);
  });

  it('fails on a monthly CSV resource without a URL', () => {
    expect(() => listMonthlyCsvResources(pkg([{ name: 'Border Notifications - April 2026', format: 'CSV' }]))).toThrow(/April 2026/);
  });
});

describe('source files', () => {
  let handle: ReturnType<typeof openDb>;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_source_files'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.delete(sourceFile);
  });

  it('finds nothing for a file never loaded', async () => {
    expect(await loadedFile(handle.db, 'uk_bn', 'https://x.test/a.csv')).toBeNull();
  });

  it('records a file and replaces its hash on a second record', async () => {
    await handle.db.transaction((tx) => recordFile(tx, 'uk_bn', 'https://x.test/a.csv', 'aaa', 5));
    expect(await loadedFile(handle.db, 'uk_bn', 'https://x.test/a.csv')).toEqual({ sha256: 'aaa' });
    expect(await loadedFile(handle.db, 'au_ifis', 'https://x.test/a.csv')).toBeNull();

    await handle.db.transaction((tx) => recordFile(tx, 'uk_bn', 'https://x.test/a.csv', 'bbb', 7));
    const rows = await handle.db.select().from(sourceFile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'uk_bn', url: 'https://x.test/a.csv', sha256: 'bbb', rows: 7 });
  });
});
