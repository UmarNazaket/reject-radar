import {
  auFailingFood,
  changeEvent,
  createDb,
  createPool,
  type Database,
  fdaRefusal,
  firm,
  firmAlias,
  firmFei,
  importAlert,
  importAlertListing,
  matchReview,
  notice,
  prepareTestDatabase,
} from '@rejectradar/db';
import { buildLinkEvidence, decideLink, linkScore, type MatchRecord } from '@rejectradar/matching';
import { parse } from 'csv-parse/sync';
import { toCsv } from './csv';
import { linkEntities } from './link-entities';
import { LABELLED_PAIR_COLUMNS, type LabelledPair, samplePairs, sampleSummary } from './sample-pairs';
import { type FixtureRecord, insertAuRow, insertFirm, insertListing, insertRefusal } from './testing';

const TODAY = '2026-10-22';
const DONGWEI_FEI = 3001234567;

/** Each row as "<decision> <country> <score>": what a sample draws, whichever pairs the seed picks. */
const drawn = (rows: readonly LabelledPair[]) => rows.map((row) => `${row.decision} ${row.country} ${row.score}`);

/** The firms each record is paired with, by record key, ids ascending. */
function firmsByRecord(rows: readonly LabelledPair[]): Record<string, number[]> {
  const firms: Record<string, number[]> = {};
  for (const { source_key, firm_id } of rows) (firms[source_key] ??= []).push(Number(firm_id));
  for (const ids of Object.values(firms)) ids.sort((a, b) => a - b);
  return firms;
}

const ascending = (...ids: number[]) => ids.sort((a, b) => a - b);

/** One side of a pair rebuilt from its row alone, as the precision gate in libs/matching rebuilds it. */
function side(row: LabelledPair, which: 'record' | 'firm'): MatchRecord {
  const orNull = (value: string) => value || null;
  return {
    nameNorm: row[`${which}_name_norm`],
    address: {
      countryCode: row.country,
      region: orNull(row[`${which}_region`]),
      city: orNull(row[`${which}_city`]),
      postalCode: orNull(row[`${which}_postal`]),
      addressNorm: orNull(row[`${which}_address_norm`]),
    },
    commodityIds: row[`${which}_commodity_ids`].split('|').filter(Boolean).map(Number),
  };
}

describe('samplePairs', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Database;

  beforeAll(async () => {
    pool = createPool(await prepareTestDatabase('entities_sample'));
    db = createDb(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    // Rows that reference a firm (or a notice, or an alert) go first.
    for (const table of [
      matchReview,
      changeEvent,
      notice,
      firmFei,
      firmAlias,
      fdaRefusal,
      importAlertListing,
      importAlert,
      auFailingFood,
      firm,
    ]) {
      await db.delete(table);
    }
  });

  /** The firm of every firm-level record, by key. */
  async function recordFirms(): Promise<Record<string, number | null>> {
    const refusals = await db.select({ key: fdaRefusal.sourceKey, firmId: fdaRefusal.firmId }).from(fdaRefusal);
    const listings = await db
      .select({ key: importAlertListing.listingKey, firmId: importAlertListing.firmId })
      .from(importAlertListing);
    const auRows = await db.select({ key: auFailingFood.sourceKey, firmId: auFailingFood.firmId }).from(auFailingFood);
    return Object.fromEntries([...refusals, ...listings, ...auRows].map(({ key, firmId }) => [key, firmId]));
  }

  /**
   * Records of 6 countries, linked by linkEntities, and 50 Pakistani mills without records here, which make "al rahman
   * rice mills" a generic name (P3-D4). Dongwei's FEI and Golden Harvest's first FEI each have an older refusal, which
   * the FEI's latest refusal stands for. The pairs they give, by band:
   * - link, all 1.0 (11): Viet Seafood's 3 Australian tests (VN), Dongwei's listing and test (CN), Gurudev's 2
   *   listings (IN) and Los Nogales' listing and test (MX), each with its own firm, which has other records; and each
   *   of Golden Harvest's 2 FEIs with the other FEI's firm (TH).
   * - review (4): Zhanjiang Evergreen "Products" and "Product", in one city (CN, 0.8653), and Al Rahman Rice Mills, in
   *   two cities (PK, 0.81), each with the other's firm.
   * - near (6): the 2 Al Rahman Rice Mills with the first 2 of the 50 mills (PK, 0.63); Mekong Delta Shrimp and Mekong
   *   Delta Shrimp Export, each with the other's firm (VN, 0.5925).
   */
  async function insertLinkedFixture() {
    const mills: number[] = [];
    for (let unit = 1; unit <= 50; unit++) {
      mills.push(await insertFirm(db, { displayName: `AL RAHMAN UNIT${unit} RICE MILLS`, countryCode: 'PK' }));
    }

    const dongwei = {
      fei: DONGWEI_FEI,
      addressLine1: 'NO.5 Fulu Centre Road',
      city: 'FUQING',
      region: 'Fujian',
      postalCode: '350300',
      countryCode: 'CN',
    };
    const dongweiOlder = await insertRefusal(db, {
      ...dongwei,
      firmName: 'FUJIAN DONGWEI FOOD CO LTD',
      commodityId: 1001,
      refusalDate: '2025-04-03',
    });
    // The FEI's latest refusal, which alone stands for the FEI in a sample.
    const dongweiLatest = await insertRefusal(db, {
      ...dongwei,
      firmName: 'FUJIAN DONGWEI FOOD CO., LTD.',
      commodityId: 1003,
      refusalDate: '2026-02-10',
    });
    const dongweiListing = await insertListing(
      db,
      {
        firmName: 'Fujian Dongwei Food Co., Ltd.',
        addressRaw: 'NO.5 Fulu Centre Road, FUQING, Fujian CHINA',
        city: 'FUQING',
        region: 'Fujian',
        countryCode: 'CN',
        countryName: 'CHINA',
        listedOn: '2024-07-08',
      },
      { notice: { commodityId: 1001 } },
    );
    const dongweiTest = await insertAuRow(db, {
      producerName: 'FUJIAN DONGWEI FOOD CO.,LTD',
      countryCode: 'CN',
      reportMonth: '2026-03-01',
      failedOn: '2026-03-02',
      commodityId: 1001,
    });

    const zhanjiang = { city: 'ZHANJIANG', region: 'Guangdong', countryCode: 'CN', countryName: 'CHINA' };
    const evergreen = [
      await insertListing(db, {
        ...zhanjiang,
        firmName: 'Zhanjiang Evergreen Aquatic Products Co., Ltd.',
        addressRaw: '18 Haibin Road, ZHANJIANG, Guangdong CHINA',
        listedOn: '2023-03-01',
      }),
      await insertListing(db, {
        ...zhanjiang,
        firmName: 'Zhanjiang Evergreen Aquatic Product Co., Ltd.',
        addressRaw: '9 Renmin Avenue, ZHANJIANG, Guangdong CHINA',
        listedOn: '2024-05-06',
      }),
    ];

    const gurudev = [
      await insertListing(
        db,
        { firmName: 'GURUDEV SPICES', countryCode: 'IN', countryName: 'INDIA', listedOn: '2022-09-14' },
        { notice: { commodityId: 202 } },
      ),
      await insertListing(
        db,
        {
          alertNumber: '99-19',
          firmName: 'Gurudev Spices',
          countryCode: 'IN',
          countryName: 'INDIA',
          listedOn: '2023-02-01',
        },
        { notice: { commodityId: 202 } },
      ),
    ];

    const nogales = [
      await insertListing(db, {
        firmName: 'Hacienda Los Nogales S.A. de C.V.',
        city: 'CULIACAN',
        region: 'Sinaloa',
        countryCode: 'MX',
        countryName: 'MEXICO',
        listedOn: '2022-01-10',
      }),
      await insertAuRow(db, {
        producerName: 'HACIENDA LOS NOGALES',
        countryCode: 'MX',
        reportMonth: '2025-08-01',
        commodityId: 600,
      }),
    ];

    // One name and address under two FEIs: two firms, as FDA gives each establishment its own FEI.
    const harvest = {
      firmName: 'GOLDEN HARVEST FOODS CO., LTD.',
      addressLine1: '88 Rama II Road',
      city: 'BANGKOK',
      postalCode: '10150',
      countryCode: 'TH',
      commodityId: 1002,
    };
    // An older refusal of the first FEI under another name, which would score 0.835 against the other FEI's firm. The
    // FEI's latest refusal stands for it, though this one was stored first.
    const harvestOlder = await insertRefusal(db, {
      ...harvest,
      fei: 3007654321,
      firmName: 'GOLDEN HARVEST FOOD INDUSTRIES CO., LTD.',
      refusalDate: '2024-01-09',
    });
    const harvestFeis = [
      await insertRefusal(db, { ...harvest, fei: 3007654321, refusalDate: '2025-11-20' }),
      await insertRefusal(db, { ...harvest, fei: 3007654322, refusalDate: '2026-06-05' }),
    ];

    const vietSeafood: FixtureRecord[] = [];
    for (const reportMonth of ['2026-01-01', '2026-02-01', '2026-04-01']) {
      vietSeafood.push(
        await insertAuRow(db, { producerName: 'Viet Seafood Co.', countryCode: 'VN', reportMonth, commodityId: 1001 }),
      );
    }
    // A candidate of Viet Seafood's records (trigram similarity 0.58) that scores below the near band: 0.4942.
    const vietnamSeafoods = await insertAuRow(db, {
      producerName: 'Vietnam Seafoods',
      countryCode: 'VN',
      reportMonth: '2026-05-01',
      commodityId: 1001,
    });
    const mekong = [
      await insertListing(db, {
        firmName: 'Mekong Delta Shrimp Co., Ltd.',
        countryCode: 'VN',
        countryName: 'VIET NAM',
        listedOn: '2024-03-04',
      }),
      await insertAuRow(db, {
        producerName: 'MEKONG DELTA SHRIMP EXPORT',
        countryCode: 'VN',
        reportMonth: '2025-10-01',
      }),
    ];

    const rahman = [
      await insertListing(
        db,
        {
          firmName: 'AL RAHMAN RICE MILLS',
          city: 'LAHORE',
          countryCode: 'PK',
          countryName: 'PAKISTAN',
          listedOn: '2021-01-04',
        },
        { notice: { commodityId: 101 } },
      ),
      await insertAuRow(db, {
        producerName: 'Al Rahman Rice Mills',
        countryCode: 'PK',
        reportMonth: '2025-04-01',
        commodityId: 101,
      }),
    ];

    await linkEntities(db, { today: TODAY });
    const firms = await recordFirms();
    const firmOf = (record: FixtureRecord): number => {
      const id = firms[record.key];
      if (id === null || id === undefined) throw new Error(`${record.key} has no firm`);
      return id;
    };
    return {
      mills,
      dongweiOlder,
      dongweiLatest,
      dongweiListing,
      dongweiTest,
      evergreen,
      gurudev,
      nogales,
      harvestFeis,
      harvestOlder,
      vietSeafood,
      vietnamSeafoods,
      mekong,
      rahman,
      firmOf,
    };
  }

  it('samples across the three bands and at least 5 countries', async () => {
    await insertLinkedFixture();

    const rows = await samplePairs(db, { count: 10, seed: 1 });

    expect(rows.map((row) => Object.keys(row))).toEqual(rows.map(() => [...LABELLED_PAIR_COLUMNS]));
    expect(rows.map(({ pair_id }) => pair_id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(drawn(rows)).toEqual([
      // Half from the link band, the countries taking turns: Viet Nam (3 pairs) first, then the others (2) by code.
      'link VN 1.0000',
      'link CN 1.0000',
      'link IN 1.0000',
      'link MX 1.0000',
      'link TH 1.0000',
      // 30% from the review band, where China and Pakistan have 2 pairs each.
      'review CN 0.8653',
      'review PK 0.8100',
      'review CN 0.8653',
      // The rest from the near band (0.50 to 0.75): Pakistan (4 pairs), then Viet Nam (2).
      'new PK 0.6300',
      'new VN 0.5925',
    ]);
    expect(sampleSummary(rows)).toEqual({
      rows: 10,
      bands: { link: 5, review: 3, near: 2 },
      countries: { CN: 3, PK: 2, VN: 2, IN: 1, MX: 1, TH: 1 },
    });
    expect(rows.every(({ label, notes }) => label === '' && notes === '')).toBe(true);
  });

  it("gives a band's shortfall to the other bands, link first", async () => {
    await insertLinkedFixture();

    // 16 pairs: 8 link, 5 review and 3 near. The review band has only 4, so the link band gives one more.
    const rows = await samplePairs(db, { count: 16, seed: 1 });

    expect(drawn(rows)).toEqual([
      'link VN 1.0000',
      'link CN 1.0000',
      'link IN 1.0000',
      'link MX 1.0000',
      'link TH 1.0000',
      'link VN 1.0000',
      'link CN 1.0000',
      'link IN 1.0000',
      'link MX 1.0000',
      'review CN 0.8653',
      'review PK 0.8100',
      'review CN 0.8653',
      'review PK 0.8100',
      'new PK 0.6300',
      'new VN 0.5925',
      'new PK 0.6300',
    ]);
  });

  it('is reproducible for a seed', async () => {
    await insertLinkedFixture();
    const pairs = (rows: readonly LabelledPair[]) => rows.map(({ source_key, firm_id }) => `${source_key} ${firm_id}`);

    const first = await samplePairs(db, { count: 10, seed: 1 });

    expect(await samplePairs(db, { count: 10, seed: 1 })).toEqual(first);
    // Another seed picks other pairs within a country, from the same bands and countries.
    const other = await samplePairs(db, { count: 10, seed: 2 });
    expect(drawn(other)).toEqual(drawn(first));
    expect(pairs(other)).not.toEqual(pairs(first));
  });

  it('never pairs a record with its own firm', async () => {
    const f = await insertLinkedFixture();
    const pair = (record: FixtureRecord, firmId: number) => `${record.key} ${firmId}`;

    // More than the fixture has: every pair.
    const pairs = (await samplePairs(db, { count: 100, seed: 1 })).map((row) => `${row.source_key} ${row.firm_id}`);

    // Not with a firm the record alone makes up.
    for (const record of [...f.evergreen, ...f.mekong, ...f.rahman]) {
      expect(pairs).not.toContain(pair(record, f.firmOf(record)));
    }
    // Nor a refusal with the firm holding its FEI, though Dongwei's firm has 3 other records and Golden Harvest's first
    // firm 1.
    for (const record of [f.dongweiLatest, ...f.harvestFeis]) {
      expect(pairs).not.toContain(pair(record, f.firmOf(record)));
    }
    // A record's firm with other records is a pair to label: the auto-links are these.
    for (const record of [f.dongweiListing, f.dongweiTest, ...f.gurudev, ...f.nogales, ...f.vietSeafood]) {
      expect(pairs).toContain(pair(record, f.firmOf(record)));
    }
  });

  it('pairs each record with its 3 best candidates scoring 0.50 or more', async () => {
    const f = await insertLinkedFixture();
    const dongwei = f.firmOf(f.dongweiListing);
    const [evergreenProducts, evergreenProduct] = f.evergreen.map(f.firmOf);
    const [harvest1, harvest2] = f.harvestFeis.map(f.firmOf);
    const [mekong, mekongExport] = f.mekong.map(f.firmOf);
    const [lahore, rahmanTest] = f.rahman.map(f.firmOf);

    const rows = await samplePairs(db, { count: 100, seed: 1 });

    // 11 link, 4 review and 6 near pairs: every pair the fixture has, each once.
    expect(rows).toHaveLength(21);
    // Not there: the older refusals of an FEI, which its latest refusal stands for; Dongwei's latest refusal, whose
    // one candidate holds its FEI; and Vietnam Seafoods, whose one candidate scores below 0.50.
    expect(firmsByRecord(rows)).toEqual({
      [f.dongweiListing.key]: [dongwei],
      [f.dongweiTest.key]: [dongwei],
      [f.evergreen[0].key]: [evergreenProduct],
      [f.evergreen[1].key]: [evergreenProducts],
      ...Object.fromEntries(f.gurudev.map((record) => [record.key, [f.firmOf(record)]])),
      ...Object.fromEntries(f.nogales.map((record) => [record.key, [f.firmOf(record)]])),
      [f.harvestFeis[0].key]: [harvest2],
      [f.harvestFeis[1].key]: [harvest1],
      ...Object.fromEntries(f.vietSeafood.map((record) => [record.key, [f.firmOf(record)]])),
      [f.mekong[0].key]: [mekongExport],
      [f.mekong[1].key]: [mekong],
      // The other city's firm (0.81), then 2 of the 50 mills (0.63 each, the lowest ids first): 3 candidates at most.
      [f.rahman[0].key]: ascending(rahmanTest, f.mills[0], f.mills[1]),
      [f.rahman[1].key]: ascending(lahore, f.mills[0], f.mills[1]),
    });
  });

  it('writes both sides of a pair as they were scored', async () => {
    const f = await insertLinkedFixture();

    const rows = await samplePairs(db, { count: 100, seed: 1 });

    const rowOf = (record: FixtureRecord, firmId: number) =>
      rows.find(({ source_key, firm_id }) => source_key === record.key && firm_id === String(firmId));
    // An Import Alert listing, with its whole address and its Red List commodity, and the firm of Dongwei's FEI, named
    // and placed as the FEI's latest refusal.
    expect(rowOf(f.dongweiListing, f.firmOf(f.dongweiListing))).toEqual({
      pair_id: expect.any(String),
      source: 'import_alert',
      source_key: f.dongweiListing.key,
      country: 'CN',
      record_raw_name: 'Fujian Dongwei Food Co., Ltd.',
      record_name_norm: 'fujian dongwei food',
      record_raw_address: 'NO.5 Fulu Centre Road, FUQING, Fujian CHINA',
      record_address_norm: '5 fulu centre road',
      record_city: 'fuqing',
      record_region: 'fujian',
      record_postal: '',
      record_commodity_ids: '1001',
      firm_id: String(f.firmOf(f.dongweiListing)),
      firm_display_name: 'FUJIAN DONGWEI FOOD CO., LTD.',
      firm_name_norm: 'fujian dongwei food',
      firm_address_norm: '5 fulu centre road',
      firm_city: 'fuqing',
      firm_region: 'fujian',
      firm_postal: '350300',
      firm_commodity_ids: '1001|1003',
      is_distinctive: 'true',
      score: '1.0000',
      decision: 'link',
      label: '',
      notes: '',
    });
    // An FDA refusal, whose address the source splits into fields.
    expect(rowOf(f.harvestFeis[1], f.firmOf(f.harvestFeis[0]))).toEqual({
      pair_id: expect.any(String),
      source: 'fda_refusal',
      source_key: f.harvestFeis[1].key,
      country: 'TH',
      record_raw_name: 'GOLDEN HARVEST FOODS CO., LTD.',
      record_name_norm: 'golden harvest foods',
      record_raw_address: '88 Rama II Road, BANGKOK, 10150',
      record_address_norm: '88 rama ii road',
      record_city: 'bangkok',
      record_region: '',
      record_postal: '10150',
      record_commodity_ids: '1002',
      firm_id: String(f.firmOf(f.harvestFeis[0])),
      firm_display_name: 'GOLDEN HARVEST FOODS CO., LTD.',
      firm_name_norm: 'golden harvest foods',
      firm_address_norm: '88 rama ii road',
      firm_city: 'bangkok',
      firm_region: '',
      firm_postal: '10150',
      firm_commodity_ids: '1002',
      is_distinctive: 'true',
      score: '1.0000',
      decision: 'link',
      label: '',
      notes: '',
    });
    // An Australian test, which gives only the producer's country, with an exact but generic name: 0.75 + 0.03 + 0.03.
    expect(rowOf(f.rahman[1], f.firmOf(f.rahman[0]))).toEqual({
      pair_id: expect.any(String),
      source: 'au_ifis',
      source_key: f.rahman[1].key,
      country: 'PK',
      record_raw_name: 'Al Rahman Rice Mills',
      record_name_norm: 'al rahman rice mills',
      record_raw_address: '',
      record_address_norm: '',
      record_city: '',
      record_region: '',
      record_postal: '',
      record_commodity_ids: '101',
      firm_id: String(f.firmOf(f.rahman[0])),
      firm_display_name: 'AL RAHMAN RICE MILLS',
      firm_name_norm: 'al rahman rice mills',
      firm_address_norm: '',
      firm_city: 'lahore',
      firm_region: '',
      firm_postal: '',
      firm_commodity_ids: '101',
      is_distinctive: 'false',
      score: '0.8100',
      decision: 'review',
      label: '',
      notes: '',
    });

    // The precision gate rescores a pair from its CSV row alone: every row holds what that takes.
    const read = parse(toCsv(LABELLED_PAIR_COLUMNS, rows), { columns: true }) as LabelledPair[];
    expect(read).toEqual(rows);
    const rescored = read.map((row) => {
      const score = linkScore(
        buildLinkEvidence(side(row, 'record'), side(row, 'firm'), { isDistinctive: row.is_distinctive === 'true' }),
      );
      return { pair: row.pair_id, score: score.toFixed(4), decision: decideLink(score) };
    });
    expect(rescored).toEqual(read.map(({ pair_id, score, decision }) => ({ pair: pair_id, score, decision })));
  });

  it('fails when the sample covers fewer than 5 countries', async () => {
    await insertLinkedFixture();

    // 2 link pairs (Viet Nam, China), 1 review (China) and 1 near (Pakistan).
    await expect(samplePairs(db, { count: 4, seed: 1 })).rejects.toThrow(
      'A sample of 4 pairs covers 3 countries (CN, PK, VN); ' +
        'spec §8.5 needs at least 5 (6 countries have pairs to sample).',
    );
  });
});
