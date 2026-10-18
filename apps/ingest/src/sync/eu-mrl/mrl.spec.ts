import { changeEvent, euMrl, euMrlProduct, euPesticideResidue, prepareTestDatabase, sourceSyncRun } from '@rejectradar/db';
import { count, desc, eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openDb } from '../../core/db';
import type { SyncDeps } from '../../core/deps';
import { fakeFetcher, fetchResult } from '../../core/test-fetcher';
import { EU_MRL_FILES, parentCode, parseMrlXml } from './parse';
import { syncEuMrl } from './sync';

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const SMALL = fixture('publication-small.xml');

const substance = (id: string, name: string, products: string) =>
  `<Substances><Name>${name}</Name><Pest_res_id>${id}</Pest_res_id><entry_force>01/01/2020</entry_force><directive>Reg. (EU) 2020/1</directive>${products}</Substances>`;
const product = (code: string, name: string, mrl: string, date = '') =>
  `<Product><Product_name>${name}</Product_name><Product_code>${code}</Product_code>${mrl}${date}</Product>`;
const wrap = (...substances: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><Pesticides><Header><Creation_Date>x</Creation_Date></Header>${substances.join('')}</Pesticides>`;

describe('EU MRL parsing', () => {
  it('lists the eight download links', () => {
    expect(EU_MRL_FILES).toHaveLength(8);
    expect(EU_MRL_FILES[0]).toBe('https://ec.europa.eu/food/plant/pesticides/eu-pesticides-database/backend/api/mrl/download/link?filename=Publication1.xml');
    expect(EU_MRL_FILES[7]).toMatch(/filename=Publication8\.xml$/);
  });

  it('parses LOD values', () => {
    const parsed = parseMrlXml(SMALL);
    expect(parsed.mrls.find((m) => m.productCode === '0110010' && m.residueId === '2275')).toEqual({
      productCode: '0110010',
      residueId: '2275',
      mrlMgKg: '0.01',
      isLod: true,
      legalRef: 'Reg. (EU) No 441/2012',
      applicableFrom: '2012-06-14',
    });
    expect(parsed.residues).toContainEqual({ id: '2275', name: 'Cadusafos', nameNorm: 'cadusafos' });
    expect(parsed.products.get('0110010')).toBe('Grapefruits');
  });

  it('parses plain values', () => {
    const parsed = parseMrlXml(SMALL);
    expect(parsed.mrls.filter((m) => !m.isLod).length).toBeGreaterThan(0);
    expect(parsed.mrls.find((m) => m.residueId === '36' && m.productCode === '0140040' && m.mrlMgKg === '10')).toEqual(
      expect.objectContaining({ isLod: false, legalRef: 'Reg. (EU) 2019/1015', applicableFrom: '2019-07-11' }),
    );
  });

  it('keeps group products without MRL rows', () => {
    const parsed = parseMrlXml(SMALL);
    // 60 product rows (30 per substance); five Captan group rows have an empty <MRL/>.
    expect(parsed.mrls).toHaveLength(55);
    const withRows = new Set(parsed.mrls.map((m) => m.productCode));
    const groups = [...parsed.products.keys()].filter((code) => !withRows.has(code));
    expect(groups.length).toBeGreaterThan(0);
  });

  it('falls back to the entry-into-force date and ignores non-numeric limits', () => {
    const parsed = parseMrlXml(
      wrap(
        substance(
          '9',
          'Zeta',
          product('0200010', 'Cabbage', '<MRL>2.5</MRL>', '<ApplicationDate/>') +
            product('0200020', 'Kale', '<MRL>No MRL Required</MRL>') +
            product('0200030', 'Leek', '<MRL></MRL>'),
        ),
      ),
    );
    expect(parsed.mrls).toEqual([
      { productCode: '0200010', residueId: '9', mrlMgKg: '2.5', isLod: false, legalRef: 'Reg. (EU) 2020/1', applicableFrom: '2020-01-01' },
    ]);
    expect([...parsed.products.keys()]).toEqual(['0200010', '0200020', '0200030']);
  });

  it('derives parent codes', () => {
    const known = new Set(['0100000', '0110000', '0110010']);
    expect(parentCode('0110010', known)).toBe('0110000');
    expect(parentCode('0110000', known)).toBe('0100000');
    expect(parentCode('0100000', known)).toBeNull();
    // A missing intermediate level is skipped.
    expect(parentCode('0110010', new Set(['0100000']))).toBe('0100000');
    expect(parentCode('0110010', new Set())).toBeNull();
  });

  it('rejects XML without Substances', () => {
    expect(() => parseMrlXml(fixture('no-substances.xml'))).toThrow(/Substances/);
  });

  it('rejects a wrong root and malformed product codes', () => {
    expect(() => parseMrlXml('<Other><Substances/></Other>')).toThrow(/Pesticides/);
    expect(() => parseMrlXml(wrap(substance('1', 'A', product('01100', 'Short', '<MRL>1</MRL>'))))).toThrow(/Product_code/);
  });
});

describe('EU MRL sync', () => {
  let handle: ReturnType<typeof openDb>;
  let deps: SyncDeps;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_mrl'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.delete(euMrl);
    await handle.db.delete(euPesticideResidue);
    await handle.db.delete(euMrlProduct);
    await handle.db.delete(sourceSyncRun);
    deps = { db: handle.db, rules: { commodity: [] } as never, today: () => '2026-10-18', fetcher: fakeFetcher(() => fetchResult('')).fetcher };
  });

  const serving = (bodyFor: (index: number) => string) => {
    const fake = fakeFetcher((url, options) => {
      expect(options?.expect).toBe('xml');
      const index = EU_MRL_FILES.indexOf(url);
      if (index < 0) throw new Error(`unexpected request ${url}`);
      return fetchResult(bodyFor(index), { contentType: 'application/xml', url });
    });
    return { ...deps, fetcher: fake.fetcher, calls: fake.calls };
  };
  const total = async (table: typeof euMrl | typeof euMrlProduct | typeof euPesticideResidue | typeof changeEvent) =>
    Number((await handle.db.select({ n: count() }).from(table))[0].n);

  it('loads all eight files, merges them and writes parent codes', async () => {
    const files = [SMALL, wrap(substance('7', 'Other', product('0110010', 'Grapefruits', '<MRL>3</MRL>'))), ...Array.from({ length: 6 }, () => SMALL)];
    const b = serving((i) => files[i]);
    const result = await syncEuMrl(b);
    expect(b.calls.map((c) => c.url)).toEqual([...EU_MRL_FILES]);
    expect(result).toMatchObject({ status: 'succeeded', rowsInserted: 56, rowsDeleted: 0, rowsUpdated: 0, eventsEmitted: 0 });
    expect(result.rowsRead).toBe(55 * 7 + 1);
    expect(await total(euMrl)).toBe(56);
    expect(await total(euPesticideResidue)).toBe(3);
    const [grapefruit] = await handle.db.select().from(euMrlProduct).where(eq(euMrlProduct.code, '0110010'));
    expect(grapefruit).toEqual({ code: '0110010', name: 'Grapefruits', parentCode: '0110000' });
    const [top] = await handle.db.select().from(euMrlProduct).where(eq(euMrlProduct.code, '0100000'));
    expect(top.parentCode).toBeNull();
    const [run] = await handle.db.select().from(sourceSyncRun).orderBy(desc(sourceSyncRun.id)).limit(1);
    expect(run).toMatchObject({ source: 'eu_mrl', status: 'succeeded', origin: EU_MRL_FILES[0], rowsInserted: 56 });
    expect(run.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('full refresh replaces everything', async () => {
    await syncEuMrl(serving(() => SMALL));
    expect(await total(euPesticideResidue)).toBe(2);

    const second = wrap(substance('9', 'Zeta', product('0200010', 'Cabbage', '<MRL>2.5</MRL>') + product('0200000', 'Leaf vegetables', '<MRL/>')));
    const result = await syncEuMrl(serving(() => second));
    expect(result).toMatchObject({ status: 'succeeded', rowsRead: 8, rowsInserted: 1, rowsDeleted: 55, eventsEmitted: 0 });
    expect((await handle.db.select().from(euPesticideResidue)).map((r) => r.id)).toEqual(['9']);
    expect((await handle.db.select().from(euMrlProduct)).map((p) => p.code).sort()).toEqual(['0200000', '0200010']);
    const rows = await handle.db.select().from(euMrl);
    expect(rows).toEqual([{ productCode: '0200010', residueId: '9', mrlMgKg: '2.5000', isLod: false, legalRef: 'Reg. (EU) 2020/1', applicableFrom: '2020-01-01' }]);
    expect(await total(changeEvent)).toBe(0);
  });

  it('leaves the tables unchanged when a file is bad', async () => {
    await syncEuMrl(serving(() => SMALL));
    const bad = serving((i) => (i === 5 ? fixture('no-substances.xml') : SMALL));
    await expect(syncEuMrl(bad)).rejects.toThrow(/Publication6\.xml.*Substances/);
    expect(await total(euMrl)).toBe(55);
    const [run] = await handle.db.select().from(sourceSyncRun).orderBy(desc(sourceSyncRun.id)).limit(1);
    expect(run.status).toBe('failed');
  });
});
