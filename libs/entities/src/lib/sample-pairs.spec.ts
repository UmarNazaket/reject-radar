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
const MEKONG_FEI = 3005551234;

/** Each row as "<decision> <country> <score>": what a sample draws, whichever pairs the seed picks. */
const drawn = (rows: readonly LabelledPair[]) => rows.map((row) => `${row.decision} ${row.country} ${row.score}`);

/** A record and a firm as "<record key> <firm id>", as `pairsOf` writes each row. */
const pair = (record: FixtureRecord, firmId: number) => `${record.key} ${firmId}`;
const pairsOf = (rows: readonly LabelledPair[]) => rows.map(({ source_key, firm_id }) => `${source_key} ${firm_id}`);

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
   * rice mills" a generic name (P3-D4). Dongwei's and Mekong Delta Shrimp's FEIs each have an older refusal, which the
   * FEI's latest refusal stands for. The pairs they give, by band:
   * - link, all 1.0 (9): Viet Seafood's 3 later Australian tests (VN), Dongwei's listing and test (CN), Gurudev's later
   *   listing (IN) and Los Nogales' test (MX), each with its own firm; and Golden Harvest's listing with the firms of
   *   its 2 FEIs (TH).
   * - review (4): Zhanjiang Evergreen "Products" and "Product", in one city (CN, 0.8653), and Al Rahman Rice Mills, in
   *   two cities (PK, 0.81), each with the other's firm.
   * - near (6): the 2 Al Rahman Rice Mills with the first 2 of the 50 mills (PK, 0.63); Mekong Delta Shrimp's refusal
   *   and the Mekong Delta Shrimp Export test, each with the other's firm (VN, 0.5925).
   * No pair joins an FEI's refusal to a firm that holds an FEI, nor a firm without an FEI to its founding record
   * (ruling R15): Dongwei's and Golden Harvest's refusals give none.
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

    // Stored before the earlier listing, which founded the firm all the same: planLinks goes by date.
    const gurudevLater = await insertListing(
      db,
      {
        alertNumber: '99-19',
        firmName: 'Gurudev Spices',
        countryCode: 'IN',
        countryName: 'INDIA',
        listedOn: '2023-02-01',
      },
      { notice: { commodityId: 202 } },
    );
    const gurudev = [
      await insertListing(
        db,
        { firmName: 'GURUDEV SPICES', countryCode: 'IN', countryName: 'INDIA', listedOn: '2022-09-14' },
        { notice: { commodityId: 202 } },
      ),
      gurudevLater,
    ];

    // Stored and dated before the listing, which founded the firm all the same: planLinks takes Import Alert before
    // Australia.
    const nogalesTest = await insertAuRow(db, {
      producerName: 'HACIENDA LOS NOGALES',
      countryCode: 'MX',
      reportMonth: '2021-08-01',
      commodityId: 600,
    });
    const nogales = [
      await insertListing(db, {
        firmName: 'Hacienda Los Nogales S.A. de C.V.',
        city: 'CULIACAN',
        region: 'Sinaloa',
        countryCode: 'MX',
        countryName: 'MEXICO',
        listedOn: '2022-01-10',
      }),
      nogalesTest,
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
    const harvestFeis = [
      await insertRefusal(db, { ...harvest, fei: 3007654321, refusalDate: '2025-11-20' }),
      await insertRefusal(db, { ...harvest, fei: 3007654322, refusalDate: '2026-06-05' }),
    ];
    // A listing of the name and address, which the engine could link to either FEI's firm: it took the first.
    const harvestListing = await insertListing(
      db,
      {
        firmName: 'Golden Harvest Foods Co., Ltd.',
        addressRaw: '88 Rama II Road, BANGKOK THAILAND',
        city: 'BANGKOK',
        countryCode: 'TH',
        countryName: 'THAILAND',
        listedOn: '2025-03-03',
      },
      { notice: { commodityId: 1002 } },
    );

    const vietSeafood: FixtureRecord[] = [];
    for (const reportMonth of ['2026-01-01', '2026-02-01', '2026-04-01', '2026-06-01']) {
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
    // An FEI whose older refusal, stored first, is nearly the Export test's name and would score 0.7746 against its
    // firm. The latest refusal, which stands for the FEI, scores 0.5925.
    const mekongAt = {
      fei: MEKONG_FEI,
      addressLine1: '45 Tran Hung Dao',
      city: 'CAN THO',
      postalCode: '900000',
      countryCode: 'VN',
      commodityId: 1001,
    };
    const mekongOlder = await insertRefusal(db, {
      ...mekongAt,
      firmName: 'MEKONG DELTA SHRIMP EXPORTS CO., LTD.',
      refusalDate: '2024-02-01',
    });
    const mekong = [
      await insertRefusal(db, { ...mekongAt, firmName: 'MEKONG DELTA SHRIMP CO., LTD.', refusalDate: '2025-07-01' }),
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
      harvestListing,
      vietSeafood,
      vietnamSeafoods,
      mekongOlder,
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
      // Half from the link band, the countries taking turns, the most pairs first: Viet Nam (3), China and Thailand
      // (2 each, by code), India and Mexico (1 each).
      'link VN 1.0000',
      'link CN 1.0000',
      'link TH 1.0000',
      'link IN 1.0000',
      'link MX 1.0000',
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

    // 16 pairs: 8 link, 5 review and 3 near. The review band has only 4, so the link band, which has 9, gives one more.
    const rows = await samplePairs(db, { count: 16, seed: 1 });

    expect(drawn(rows)).toEqual([
      'link VN 1.0000',
      'link CN 1.0000',
      'link TH 1.0000',
      'link IN 1.0000',
      'link MX 1.0000',
      'link VN 1.0000',
      'link CN 1.0000',
      'link TH 1.0000',
      'link VN 1.0000',
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

    const first = await samplePairs(db, { count: 10, seed: 1 });

    expect(await samplePairs(db, { count: 10, seed: 1 })).toEqual(first);
    // Another seed picks other pairs within a country, from the same bands and countries.
    const other = await samplePairs(db, { count: 10, seed: 2 });
    expect(drawn(other)).toEqual(drawn(first));
    expect(pairsOf(other)).not.toEqual(pairsOf(first));
  });

  it('never pairs a record with its own firm', async () => {
    const f = await insertLinkedFixture();

    // More than the fixture has: every pair.
    const pairs = pairsOf(await samplePairs(db, { count: 100, seed: 1 }));

    // Not with a firm the record alone makes up.
    for (const record of [...f.evergreen, f.mekong[1], ...f.rahman, f.vietnamSeafoods]) {
      expect(pairs).not.toContain(pair(record, f.firmOf(record)));
    }
    // Nor a refusal with the firm holding its FEI, though Dongwei's firm has 3 other records and Mekong's 1.
    for (const record of [f.dongweiLatest, ...f.harvestFeis, f.mekong[0]]) {
      expect(pairs).not.toContain(pair(record, f.firmOf(record)));
    }
    // A record's firm that is more than the record is a pair to label: the auto-links are these.
    for (const record of [f.dongweiListing, f.harvestListing, f.gurudev[1], f.vietSeafood[1]]) {
      expect(pairs).toContain(pair(record, f.firmOf(record)));
    }
  });

  it("pairs an FEI's refusal only with firms that hold no FEI", async () => {
    const f = await insertLinkedFixture();
    const [harvest1, harvest2] = f.harvestFeis.map(f.firmOf);

    const rows = await samplePairs(db, { count: 100, seed: 1 });

    // The engine links a new FEI's refusals to the FEI's own firm or to a firm without an FEI, and gives another FEI's
    // firm at most a second_fei review (P3-D5). So each Golden Harvest refusal, though it scores 1.0 against the other
    // FEI's firm, gives no pair, while Mekong Delta Shrimp's is paired with the Export test's firm, which has no FEI.
    expect(pairsOf(rows.filter(({ source }) => source === 'fda_refusal'))).toEqual([
      pair(f.mekong[0], f.firmOf(f.mekong[1])),
    ]);
    // Other records are paired with firms holding an FEI: the engine could link the listing to either of these.
    expect(pairsOf(rows)).toEqual(
      expect.arrayContaining([pair(f.harvestListing, harvest1), pair(f.harvestListing, harvest2)]),
    );
  });

  it('never pairs a firm without an FEI with its founding record', async () => {
    const f = await insertLinkedFixture();

    const pairs = pairsOf(await samplePairs(db, { count: 100, seed: 1 }));

    // Such a firm took its name and address from its first record in planLinks' order (by source, then date, then
    // key), which it copies: Gurudev's earlier listing, stored after the later one; Los Nogales' listing, stored and
    // dated after its Australian test; and Viet Seafood's first test.
    for (const record of [f.gurudev[0], f.nogales[0], f.vietSeafood[0]]) {
      expect(pairs).not.toContain(pair(record, f.firmOf(record)));
    }
    // The firm's other records are pairs to label.
    for (const record of [f.gurudev[1], f.nogales[1], ...f.vietSeafood.slice(1)]) {
      expect(pairs).toContain(pair(record, f.firmOf(record)));
    }
    // A firm that holds an FEI keeps its pairs with the listings and tests linked to it.
    for (const record of [f.dongweiListing, f.dongweiTest, f.harvestListing]) {
      expect(pairs).toContain(pair(record, f.firmOf(record)));
    }
  });

  it('never pairs a firm that later took an FEI with its founding record', async () => {
    await insertLinkedFixture();
    // A refusal without an FEI builds a firm. A refusal of a new FEI, dated later, matches it by name and address, so
    // the firm takes the FEI (P3-D5); a listing links to it too. All in one run.
    const siam = { addressLine1: '12 Sukhumvit Road', city: 'BANGKOK', countryCode: 'TH' };
    const founder = await insertRefusal(db, { ...siam, firmName: 'SIAM CANNING CO., LTD.', refusalDate: '2023-05-02' });
    const refusal = await insertRefusal(db, {
      ...siam,
      fei: 3001112223,
      firmName: 'SIAM CANNING CO LTD',
      refusalDate: '2024-08-06',
    });
    const listing = await insertListing(db, {
      firmName: 'Siam Canning Co., Ltd.',
      addressRaw: '12 Sukhumvit Road, BANGKOK THAILAND',
      city: 'BANGKOK',
      countryCode: 'TH',
      countryName: 'THAILAND',
      listedOn: '2024-09-01',
    });
    await linkEntities(db, { today: TODAY });
    const firms = await recordFirms();
    const siamFirm = firms[founder.key] as number;
    // The new FEI's refusal is on the founder's firm: the firm took the FEI.
    expect([firms[refusal.key], firms[listing.key]]).toEqual([siamFirm, siamFirm]);

    const pairs = pairsOf(await samplePairs(db, { count: 100, seed: 1 }));

    // The founding refusal against the firm that copies it would score 1.0; the listing is a pair to label.
    expect(pairs).not.toContain(pair(founder, siamFirm));
    expect(pairs).toContain(pair(listing, siamFirm));
  });

  it('pairs each record with its 3 best candidates scoring 0.50 or more', async () => {
    const f = await insertLinkedFixture();
    const dongwei = f.firmOf(f.dongweiListing);
    const [evergreenProducts, evergreenProduct] = f.evergreen.map(f.firmOf);
    const [harvest1, harvest2] = f.harvestFeis.map(f.firmOf);
    const [mekong, mekongExport] = f.mekong.map(f.firmOf);
    const [lahore, rahmanTest] = f.rahman.map(f.firmOf);

    const rows = await samplePairs(db, { count: 100, seed: 1 });

    // 9 link, 4 review and 6 near pairs: every pair the fixture has, each once.
    expect(rows).toHaveLength(19);
    // Not there: the older refusals of an FEI, which its latest refusal stands for; Dongwei's and Golden Harvest's
    // refusals, whose candidates all hold an FEI; the founding records of Gurudev's, Los Nogales' and Viet Seafood's
    // firms; and Vietnam Seafoods, whose other candidate scores below 0.50.
    expect(firmsByRecord(rows)).toEqual({
      [f.dongweiListing.key]: [dongwei],
      [f.dongweiTest.key]: [dongwei],
      [f.evergreen[0].key]: [evergreenProduct],
      [f.evergreen[1].key]: [evergreenProducts],
      [f.gurudev[1].key]: [f.firmOf(f.gurudev[1])],
      [f.nogales[1].key]: [f.firmOf(f.nogales[1])],
      [f.harvestListing.key]: ascending(harvest1, harvest2),
      ...Object.fromEntries(f.vietSeafood.slice(1).map((record) => [record.key, [f.firmOf(record)]])),
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
    // An FDA refusal, whose address the source splits into fields, near a firm built from an Australian test: 0.5925.
    expect(rowOf(f.mekong[0], f.firmOf(f.mekong[1]))).toEqual({
      pair_id: expect.any(String),
      source: 'fda_refusal',
      source_key: f.mekong[0].key,
      country: 'VN',
      record_raw_name: 'MEKONG DELTA SHRIMP CO., LTD.',
      record_name_norm: 'mekong delta shrimp',
      record_raw_address: '45 Tran Hung Dao, CAN THO, 900000',
      record_address_norm: '45 tran hung dao',
      record_city: 'can tho',
      record_region: '',
      record_postal: '900000',
      record_commodity_ids: '1001',
      firm_id: String(f.firmOf(f.mekong[1])),
      firm_display_name: 'MEKONG DELTA SHRIMP EXPORT',
      firm_name_norm: 'mekong delta shrimp export',
      firm_address_norm: '',
      firm_city: '',
      firm_region: '',
      firm_postal: '',
      firm_commodity_ids: '',
      is_distinctive: 'true',
      score: '0.5925',
      decision: 'new',
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
