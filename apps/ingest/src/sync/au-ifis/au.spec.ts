import { auFailingFood, changeEvent, notice, prepareTestDatabase, sourceFile, sourceSyncRun } from '@rejectradar/db';
import { insertFirm } from '@rejectradar/entities';
import { count, desc, eq, inArray } from 'drizzle-orm';
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
const URL_JUNE_2019 =
  'https://data.gov.au/data/dataset/e56bcf6a-7bfb-4cb5-8c65-8ec18bd4b7d5/resource/736e1585-c05f-4ff6-8e50-569ea094ce6d/download/imported-food-inspection-scheme-june-2019-failing-food-report-data.csv';
/** The live listing's entry for June 2019, the oldest file and the first in the several-tables layout. */
const PACKAGE_2019 = { result: { resources: [{ format: '.csv', name: 'Imported Food Inspection Scheme - June 2019 failing food report data.csv', url: URL_JUNE_2019 }] } };
const HEADER = 'Date of fail,Product description,County of origin,Producer Name,Test applied / reason for fail,Results / Units,Reference criteria,Food category';

const record = (overrides: Partial<AuRecord> = {}): AuRecord => ({
  sourceKey: 'k',
  reportMonth: '2026-07-01',
  failedOn: '2026-07-01',
  productDesc: 'Product',
  countryCode: 'IN',
  countryName: 'India',
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

  it('keeps the keys of records in the single-table layout', () => {
    const keys = (file: string, month: string) => parseAuCsv(fixture(file), month).map((r) => r.sourceKey);
    expect(keys('may-2026.csv', '2026-05-01')).toEqual(expect.arrayContaining(['2e1875bb87fbbd235f98326c25f99bfecdde010f', 'c77a05760f70c77687fdacd6b463a0d7584a71ab']));
    expect(keys('june-2026.csv', '2026-06-01')).toEqual(expect.arrayContaining(['fc6b146986486a08a901b58970b5dc234a66bad4', 'f924451b62148e17432db70e1d4dc684775f30b1']));
    expect(keys('july-2026.csv', '2026-07-01')).toEqual(expect.arrayContaining(['10f0e8d68e5ac836a3f1853e395c1ba377927f46', '37b98a6f97a3e8817eccc626551967769b5d343e']));
  });
});

describe('Australian failing-food parsing, 2019-2022 layouts', () => {
  const schemes = (records: AuRecord[]) => records.map((r) => r.scheme);
  const byProduct = (records: AuRecord[], product: string) => records.filter((r) => r.productDesc === product);

  it('reads every table of a June 2019 file, taking the scheme from its title', () => {
    const records = parseAuCsv(fixture('june-2019.csv'), '2019-06-01');
    expect(records).toHaveLength(34);
    // "Risk microbiological and allergen fails" (10), "Risk chemical/contaminant/ toxin test results" (6),
    // "Surveillance catergory food fails" (18).
    expect(schemes(records)).toEqual([...Array<string>(16).fill('risk'), ...Array<string>(18).fill('surveillance')]);
    expect(records[0]).toMatchObject({
      reportMonth: '2019-06-01',
      failedOn: '2019-06-05',
      productDesc: 'Kashmiri chilli powder',
      countryCode: 'IN',
      producerName: 'Anna Aluminium Co Pvt Ltd',
      testApplied: 'Salmonella',
      reason: 'Salmonella',
      resultText: 'Detected/125g',
      holdingOrderMatch: null,
    });
    expect(byProduct(records, 'Frozen cooked prawns')[0].resultText).toBe('700 000, 10 000, 6 000, 110 000, 140 000 cfu/g');
    expect(byProduct(records, 'Cassava chips')[0]).toMatchObject({ scheme: 'risk', testApplied: 'Hydrocyanic acid', reason: 'Hydrocyanic acid', resultText: '11 mg/kg' });
  });

  it('reads the surveillance rows of June 2019, which carry a test column their header lacks', () => {
    const records = parseAuCsv(fixture('june-2019.csv'), '2019-06-01');
    expect(byProduct(records, 'Mung dhal')[0]).toMatchObject({
      scheme: 'surveillance',
      testApplied: 'Fruit and vegetable residue screen',
      reason: 'Chlorpyrifos',
      resultText: '0.03 mg/kg',
    });
    expect(byProduct(records, 'Frozen seasoned flying fish roe')[0]).toMatchObject({
      testApplied: 'Composition',
      reason: 'Additive E127 (erythrosine)',
      resultText: 'Not permitted in this food',
    });
    expect(byProduct(records, 'Pilchards in hot chilli sauce')[0]).toMatchObject({ failedOn: '2019-05-31', reason: 'Irradiated cayenne pepper' });
  });

  it('keys a record of a file with separate test and reason columns on both', () => {
    const header = 'Date of fail,Product description,Country of origin,Producer name,Test applied,Reason for fail,Result/s,Units,Reference';
    const line = (reason: string) => `5/06/2019,Mung dhal,Myanmar,Ays Mfg Co Ltd,Fruit and vegetable residue screen,${reason},0.03,mg/kg,FSC 1.4.2`;
    const [a, b] = parseAuCsv(`${header}\n${line('Chlorpyrifos')}\n${line('Profenofos')}\n`, '2019-06-01');
    expect(a.sourceKey).not.toBe(b.sourceKey);
    expect(parseAuCsv(`${header}\n${line('Profenofos')}\n`, '2019-06-01')[0].sourceKey).toBe(b.sourceKey);
  });

  it('reads holding order numbers, a continuation row and a footnote of March 2020', () => {
    const records = parseAuCsv(fixture('march-2020.csv'), '2020-03-01');
    expect(records).toHaveLength(31);
    expect(schemes(records)).toEqual([...Array<string>(10).fill('risk'), ...Array<string>(21).fill('surveillance')]);
    expect(byProduct(records, 'Peanut candy bar')[0]).toMatchObject({
      reason: 'Aflatoxin',
      resultText: '0.012 mg/kg; (product contains 75% peanut, therefore the calculated maximum level is 0.011)',
      holdingOrderMatch: null,
    });
    expect(byProduct(records, 'Dried elberta peaches halves')[0]).toMatchObject({
      testApplied: 'Fruit and vegetable residue screen',
      reason: 'Thiabendazole',
      resultText: '0.046 mg/kg',
      holdingOrderMatch: true,
    });
    expect(byProduct(records, 'Frozen dried longan').map((r) => r.holdingOrderMatch)).toEqual([true, true]);
    // "n/a" units are left out; "n/a*" (no holding order, see the footnote) is not a holding order.
    expect(byProduct(records, 'Pan masala')[0]).toMatchObject({ reason: 'Areca catechu', resultText: 'Prohibited plant', holdingOrderMatch: true });
    expect(byProduct(records, 'Sardines in tomato sauce with chilli')[0]).toMatchObject({ holdingOrderMatch: null });
    expect(byProduct(records, 'Dietary supplement')[0].reason).toBe('St John’s wort extract (Hypericum perforatum)');
  });

  it('completes a record whose product, country or producer runs on into the row below it (July 2020)', () => {
    const records = parseAuCsv(fixture('july-2020.csv'), '2020-07-01');
    expect(records).toHaveLength(29);
    expect(schemes(records)).toEqual([...Array<string>(9).fill('risk'), ...Array<string>(20).fill('surveillance')]);
    expect(records.filter((r) => r.failedOn === null || r.productDesc.startsWith('('))).toEqual([]);
    expect(records.map((r) => r.productDesc)).toEqual(expect.arrayContaining(['Keeramin (dried fish)', 'Door dal (peas)', 'Pickled plum (Shiso Zuke Ume)']));
    expect(byProduct(records, 'Canned coconut')[0]).toMatchObject({ countryCode: 'CN', producerName: 'Baoding City Jiakang Food Co., Ltd' });
    expect(byProduct(records, 'Formulated supplementary sports drink')[0]).toMatchObject({ countryCode: 'US', producerName: 'Simpson Laboratories' });
    expect(byProduct(records, 'Betel nut')[1]).toMatchObject({ countryCode: 'PG', producerName: 'Magdaline Maino', testApplied: 'Composition', reason: 'Areca catechu; (Betel nut)' });
  });

  it('keeps a row with no date but a product, country and producer as a record of its own', () => {
    const records = parseAuCsv(`${HEADER}\n5/07/2026,Chilli powder,India,Mr Agro,Salmonella detected,,,\n,Chilli flakes,India,Mr Agro,Salmonella detected,,,\n`, '2026-07-01');
    expect(records.map((r) => [r.failedOn, r.productDesc])).toEqual([
      ['2026-07-05', 'Chilli powder'],
      [null, 'Chilli flakes'],
    ]);
  });

  it('reads a D.M.YYYY date (September 2020)', () => {
    expect(parseAuCsv(`${HEADER}\n31.8.2020,Fermented bean curd,Vietnam,Tyh Import Export Service,Bacillus cereus,,,\n`, '2020-09-01')[0].failedOn).toBe('2020-08-31');
  });

  it('reads the numbered table titles of December 2021', () => {
    const records = parseAuCsv(fixture('december-2021.csv'), '2021-12-01');
    expect(records).toHaveLength(22);
    expect(schemes(records)).toEqual([...Array<string>(5).fill('risk'), ...Array<string>(17).fill('surveillance')]);
  });

  it('reads the Category column of January 2022', () => {
    const records = parseAuCsv(fixture('january-2022.csv'), '2022-01-01');
    expect(records).toHaveLength(23);
    expect(records[0]).toMatchObject({
      failedOn: '2022-01-04',
      productDesc: 'Sesame seed',
      scheme: 'risk',
      testApplied: 'Salmonella',
      reason: 'Salmonella detected.',
      resultText: 'Detected/125g',
      holdingOrderMatch: null,
    });
    expect(records[1]).toMatchObject({
      productDesc: 'Cream crackers',
      scheme: 'surveillance',
      testApplied: 'Composition',
      reason: 'Vitamin B12 and Iodine not permitted in this food.',
      resultText: 'N/A',
      holdingOrderMatch: true,
    });
    expect(byProduct(records, 'Mussels')[0].resultText).toBe('>110, <2.3, >110, 46, 2.3 MPN/g');
    expect(byProduct(records, 'Soybeans')[0]).toMatchObject({ scheme: 'surveillance', holdingOrderMatch: true });
  });

  it('reads October 2022, whose test column is headed "Results / Units" like the results column', () => {
    const records = parseAuCsv(fixture('october-2022.csv'), '2022-10-01');
    expect(records).toHaveLength(17);
    expect(records[0]).toMatchObject({
      productDesc: 'Dragon fruit',
      testApplied: 'Fruit & vegetable residue screen - Permethrin detected in excess of MRL',
      reason: 'Fruit & vegetable residue screen - Permethrin detected in excess of MRL',
      resultText: '0.11 mg/kg',
      scheme: 'surveillance',
      holdingOrderMatch: true,
    });
  });

  it('reads February 2025, which has no header row and Excel serial dates', () => {
    const records = parseAuCsv(fixture('february-2025.csv'), '2025-02-01');
    expect(records).toHaveLength(27);
    expect(records[0]).toMatchObject({
      failedOn: '2025-01-30',
      productDesc: 'Processed pistachios',
      countryCode: 'CN',
      producerName: 'Sun Wing Nuts & Food Co. Ltd.',
      testApplied: 'Aflatoxin detected in excess of level permitted',
      resultText: '0.25 mg/kg, 0.055 mg/kg',
      scheme: 'risk',
    });
    expect(records[26]).toMatchObject({ failedOn: '2025-02-28', productDesc: 'Marinated sardines' });
    expect(records.filter((r) => r.holdingOrderMatch)).toHaveLength(13);
  });

  it('rejects a title that no header follows, and text that is neither a title, a footnote nor a record', () => {
    expect(() => parseAuCsv(`Risk food tests\n5/07/2026,Chilli powder,India,Mr Agro,Salmonella detected,,,\n`, '2026-07-01')).toThrow(/row 2.*"Risk food tests"/);
    expect(() => parseAuCsv(`${HEADER}\n5/07/2026,Chilli powder,India,Mr Agro,Salmonella detected,,,\nSee the notes below\n`, '2026-07-01')).toThrow(
      /row 3.*"See the notes below"/,
    );
    expect(() => parseAuCsv(`${HEADER}\nRisk food tests\n`, '2026-07-01')).toThrow(/row 2.*"Risk food tests".*no header/);
  });

  it('rejects a value under no header, unless the table lacks the test column the value belongs to', () => {
    expect(() => parseAuCsv(`${HEADER}\n5/07/2026,Chilli powder,India,Mr Agro,Salmonella detected,Detected/125g,FSC 1.6.1,Risk,Extra\n`, '2026-07-01')).toThrow(
      /row 2 has a value under no header: "Extra"/,
    );
  });

  it('rejects a file whose first row is neither a header, a title nor a record', () => {
    expect(() => parseAuCsv(`Chilli powder,India,Mr Agro\n`, '2026-07-01')).toThrow(/no header row/);
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

  it('classifies the reason for fail as well as the test applied', () => {
    expect(classifyAu(rules, record({ productDesc: 'Mung dhal', testApplied: 'Fruit and vegetable residue screen', reason: 'Chlorpyrifos' })).hazardIds).toEqual([100]);
  });

  it('falls back to unclassified', () => {
    expect(classifyAu(rules, record({ productDesc: 'Mystery', testApplied: 'Something odd' })).hazardIds).toEqual([1200]);
  });

  it('classifies the tests and products that the rules of migration 0009 cover', () => {
    const hcn = 'Hydrocyanic acid detected in excess of level permitted';
    expect(classifyAu(rules, record({ productDesc: 'Tapioca chips', testApplied: hcn, reason: hcn }))).toEqual({ commodityId: 1300, hazardIds: [601] });
    expect(classifyAu(rules, record({ productDesc: 'Fresh lychee', testApplied: 'Fruit and vegetable residue screen', reason: 'Difenoconazole' }))).toEqual({
      commodityId: 600,
      hazardIds: [100],
    });
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

  /** Serves the package list (`listing`) and the monthly files it may name; `files` replaces any of them. */
  const backend = (files: Record<string, string | Buffer> = {}, failing: string[] = [], listing: unknown = PACKAGE) => {
    const served: Record<string, string | Buffer> = {
      [URL_MAY]: fixtureBytes('may-2026.csv'),
      [URL_JUNE]: fixtureBytes('june-2026.csv'),
      [URL_JULY]: fixtureBytes('july-2026.csv'),
      [URL_JUNE_2019]: fixtureBytes('june-2019.csv'),
      ...files,
    };
    const fake = fakeFetcher((url, options) => {
      if (url === AU_PACKAGE_URL) {
        expect(options?.expect).toBe('json');
        return fetchResult(JSON.stringify(listing), { contentType: 'application/json', url });
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

  it('pairs a corrected record on the country as the file names it, not on its stored code', async () => {
    await syncAuIfis(backend(), options);
    const before = parseAuCsv(fixture('july-2026.csv'), '2026-07-01')[1];
    const [oldNotice] = await handle.db.select().from(notice).where(eq(notice.sourceKey, before.sourceKey));
    const events = await total(changeEvent);
    // As if the codes were stored under an earlier country-alias table: phase 3 may map names to other codes.
    await handle.db.update(notice).set({ originCountry: 'ZZ' });
    await handle.db.update(auFailingFood).set({ countryCode: 'ZZ' });

    const corrected = editedJuly(',Listeria monocytogenes detected,', ',Listeria monocytogenes detected in excess of level permitted,');
    const result = await syncAuIfis(backend({ [URL_JULY]: corrected }), options);
    expect(result).toMatchObject({ rowsInserted: 0, rowsDeleted: 0, eventsEmitted: 0 });
    expect(await total(changeEvent)).toBe(events);
    const after = parseAuCsv(corrected, '2026-07-01')[1];
    const [moved] = await handle.db.select().from(notice).where(eq(notice.sourceKey, after.sourceKey));
    expect(moved).toMatchObject({ id: oldNotice.id, originCountry: 'IT' });
    const [typed] = await handle.db.select().from(auFailingFood).where(eq(auFailingFood.sourceKey, after.sourceKey));
    expect(typed).toMatchObject({ countryCode: 'IT', countryName: 'Italy' });
  });

  it('treats a record whose producer changed as a new record, with an event', async () => {
    await syncAuIfis(backend(), options);
    const result = await syncAuIfis(backend({ [URL_JULY]: editedJuly(',Latteria Moro Di Moro Sergio,', ',Another Dairy,') }), options);
    expect(result).toMatchObject({ rowsInserted: 1, rowsUpdated: 0, rowsDeleted: 1, eventsEmitted: 1 });
  });

  /** Links these records to a new firm at score 0.9, as entities:link would; returns the firm's id. */
  const link = async (keys: string[]) => {
    const firmId = await insertFirm(handle.db);
    await handle.db.update(auFailingFood).set({ firmId, linkScore: '0.9000' }).where(inArray(auFailingFood.sourceKey, keys));
    return firmId;
  };
  const typedRow = async (key: string) => (await handle.db.select().from(auFailingFood).where(eq(auFailingFood.sourceKey, key)))[0];
  const correctedJuly = () => editedJuly(',Listeria monocytogenes detected,', ',Listeria monocytogenes detected in excess of level permitted,');

  it('a corrected Australian producer loses its firm', async () => {
    await syncAuIfis(backend(), options);
    const [other, before] = parseAuCsv(fixture('july-2026.csv'), '2026-07-01');
    const firmId = await link([other.sourceKey, before.sourceKey]);
    // A corrected record keeps its producer's raw name (a new name makes a new record, above), so what a correction
    // changes is the normalised name: as if it was stored by an earlier normalizeName.
    await handle.db.update(auFailingFood).set({ nameNorm: 'latteria moro' }).where(eq(auFailingFood.sourceKey, before.sourceKey));
    const after = parseAuCsv(correctedJuly(), '2026-07-01')[1];
    const result = await syncAuIfis(backend({ [URL_JULY]: correctedJuly() }), options);
    expect(result).toMatchObject({ rowsInserted: 0, rowsUpdated: 1, rowsDeleted: 0 });
    expect(await typedRow(after.sourceKey)).toMatchObject({ nameNorm: before.nameNorm, firmId: null, linkScore: null });
    expect(await typedRow(other.sourceKey)).toMatchObject({ firmId, linkScore: '0.9000' });
  });

  it('a corrected Australian record whose producer and country are unchanged keeps its firm', async () => {
    await syncAuIfis(backend(), options);
    const before = parseAuCsv(fixture('july-2026.csv'), '2026-07-01')[1];
    const firmId = await link([before.sourceKey]);
    const after = parseAuCsv(correctedJuly(), '2026-07-01')[1];
    expect(await syncAuIfis(backend({ [URL_JULY]: correctedJuly() }), options)).toMatchObject({ rowsUpdated: 1 });
    expect(await typedRow(after.sourceKey)).toMatchObject({
      testApplied: 'Listeria monocytogenes detected in excess of level permitted',
      firmId,
      linkScore: '0.9000',
    });
  });

  it('an Australian record whose country code changes loses its firm', async () => {
    await syncAuIfis(backend(), options);
    const [first, , third] = parseAuCsv(fixture('july-2026.csv'), '2026-07-01');
    const firmId = await link([first.sourceKey, third.sourceKey]);
    // As if the code was stored under an earlier country-alias table; the file changed elsewhere, so it is loaded again.
    await handle.db.update(auFailingFood).set({ countryCode: 'ZZ' }).where(eq(auFailingFood.sourceKey, first.sourceKey));
    await syncAuIfis(backend({ [URL_JULY]: changedJuly() }), options);
    expect(await typedRow(first.sourceKey)).toMatchObject({ countryCode: 'JP', firmId: null, linkScore: null });
    expect(await typedRow(third.sourceKey)).toMatchObject({ firmId, linkScore: '0.9000' });
  });

  it('loads a June 2019 file, titling a record by its reason, and updates a corrected record of it in place', async () => {
    const first = await syncAuIfis(backend({}, [], PACKAGE_2019), options);
    expect(first).toMatchObject({ status: 'succeeded', rowsRead: 34, rowsInserted: 34, eventsEmitted: 34 });
    const [mung] = await handle.db.select().from(notice).where(eq(notice.productText, 'Mung dhal'));
    expect(mung).toMatchObject({ title: 'Mung dhal failed: Chlorpyrifos', noticeOn: '2019-06-05', originCountry: 'MM', url: URL_JUNE_2019 });
    const [typed] = await handle.db.select().from(auFailingFood).where(eq(auFailingFood.sourceKey, mung.sourceKey));
    expect(typed).toMatchObject({ reportMonth: '2019-06-01', testApplied: 'Fruit and vegetable residue screen', reason: 'Chlorpyrifos', resultText: '0.03 mg/kg', scheme: 'surveillance' });
    expect(typed.hazardIds).toEqual([100]);

    const line = '5/06/2019,Mung dhal,Myanmar,Ays Mfg Co Ltd,Fruit and vegetable residue screen,Chlorpyrifos,0.03,mg/kg,FSC 1.4.2';
    const original = fixture('june-2019.csv');
    expect(original).toContain(line);
    const corrected = original.replace(line, line.replace(',Chlorpyrifos,', ',Chlorpyrifos detected in excess of MRL,'));
    const second = await syncAuIfis(backend({ [URL_JUNE_2019]: corrected }, [], PACKAGE_2019), options);
    expect(second).toMatchObject({ rowsRead: 34, rowsInserted: 0, rowsUpdated: 1, rowsDeleted: 0, eventsEmitted: 0 });
    const [moved] = await handle.db.select().from(notice).where(eq(notice.productText, 'Mung dhal'));
    expect(moved).toMatchObject({ id: mung.id, title: 'Mung dhal failed: Chlorpyrifos detected in excess of MRL' });
    expect(moved.sourceKey).not.toBe(mung.sourceKey);
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
