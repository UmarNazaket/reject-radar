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
import { asc, eq, sql } from 'drizzle-orm';
import { linkEntities, type LinkRunResult } from './link-entities';
import { insertAuRow, insertEvent, insertFirm, insertListing, insertRefusal } from './testing';

const TODAY = '2026-10-22';
const DONGWEI_FEI = 3001234567;
const GOLDEN_HARVEST_FEI = 3007654321;

/** The result of a run that finds nothing to do, apart from its time. */
const NOTHING: Omit<LinkRunResult, 'ms'> = {
  records: { fda_refusal: 0, import_alert: 0, au_ifis: 0 },
  firmsCreated: 0,
  linked: 0,
  feisAssigned: 0,
  reviews: { score_band: 0, second_fei: 0 },
  noticesUpdated: 0,
  eventsUpdated: 0,
  firmsRefreshed: 0,
};

describe('linkEntities', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Database;

  beforeAll(async () => {
    pool = createPool(await prepareTestDatabase('entities_run'));
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

  /**
   * Unlinked records, each with its notice: 4 refusals under 2 FEIs (one country each); 3 Import Alert listings, one
   * of the first FEI's firm (same distinctive name and city) and two of a Vietnamese firm with the second FEI's name;
   * and 2 Australian tests, one of the first FEI's firm and one without a producer.
   */
  async function insertFixture() {
    const dongwei = {
      fei: DONGWEI_FEI,
      addressLine1: 'NO.5 Fulu Centre Road',
      city: 'FUQING',
      region: 'Fujian',
      countryCode: 'CN',
      commodityId: 1001,
    };
    const goldenHarvest = {
      fei: GOLDEN_HARVEST_FEI,
      firmName: 'GOLDEN HARVEST FOODS CO., LTD.',
      addressLine1: '88 Rama II Road',
      city: 'BANGKOK',
      countryCode: 'TH',
      commodityId: 1002,
    };
    const refusals = [
      await insertRefusal(
        db,
        { ...dongwei, firmName: 'FUJIAN DONGWEI FOOD CO LTD', refusalDate: '2025-04-03' },
        { notice: true },
      ),
      // The FEI's latest refusal: its firm takes this name.
      await insertRefusal(
        db,
        { ...dongwei, firmName: 'FUJIAN DONGWEI FOOD CO., LTD.', refusalDate: '2026-02-10' },
        { notice: true },
      ),
      await insertRefusal(db, { ...goldenHarvest, refusalDate: '2025-11-20' }, { notice: true }),
      await insertRefusal(db, { ...goldenHarvest, refusalDate: '2026-06-05' }, { notice: true }),
    ];
    const vietnamese = {
      firmName: 'GOLDEN HARVEST FOODS CO., LTD.',
      addressRaw: '12 Nguyen Hue, HO CHI MINH CITY VIET NAM',
      city: 'HO CHI MINH CITY',
      countryCode: 'VN',
      countryName: 'VIET NAM',
    };
    const listings = [
      await insertListing(
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
      ),
      await insertListing(db, { ...vietnamese, alertNumber: '99-08', listedOn: '2023-05-02' }, { notice: true }),
      await insertListing(db, { ...vietnamese, alertNumber: '16-120', listedOn: '2024-01-15' }, { notice: true }),
    ];
    const auRows = [
      await insertAuRow(
        db,
        {
          producerName: 'FUJIAN DONGWEI FOOD CO.,LTD',
          countryCode: 'CN',
          reportMonth: '2026-03-01',
          failedOn: '2026-03-02',
          commodityId: 1001,
        },
        { notice: true },
      ),
      await insertAuRow(db, { producerName: null, countryCode: 'VN' }, { notice: true }),
    ];
    return { refusals, listings, auRows };
  }

  /** firm_id of every firm-level record, by source and key. */
  async function recordFirms(): Promise<Record<string, number | null>> {
    const refusals = await db.select({ key: fdaRefusal.sourceKey, firmId: fdaRefusal.firmId }).from(fdaRefusal);
    const listings = await db
      .select({ key: importAlertListing.listingKey, firmId: importAlertListing.firmId })
      .from(importAlertListing);
    const auRows = await db.select({ key: auFailingFood.sourceKey, firmId: auFailingFood.firmId }).from(auFailingFood);
    return Object.fromEntries([
      ...refusals.map(({ key, firmId }) => [`fda_refusal/${key}`, firmId]),
      ...listings.map(({ key, firmId }) => [`import_alert/${key}`, firmId]),
      ...auRows.map(({ key, firmId }) => [`au_ifis/${key}`, firmId]),
    ]);
  }

  async function firmOfFei(fei: number): Promise<number> {
    const [row] = await db.select({ firmId: firmFei.firmId }).from(firmFei).where(eq(firmFei.fei, fei));
    return row.firmId;
  }

  it('links every firm-level record', async () => {
    const { refusals, listings, auRows } = await insertFixture();
    for (const [source, record] of [
      ['fda_refusal', refusals[0]],
      ['import_alert', listings[2]],
      ['au_ifis', auRows[1]],
    ] as const) {
      await insertEvent(db, { source, sourceKey: record.key, noticeId: record.noticeId });
    }

    const result = await linkEntities(db, { today: TODAY });

    expect(result).toEqual({
      // The Australian test without a producer is never loaded.
      records: { fda_refusal: 4, import_alert: 3, au_ifis: 1 },
      firmsCreated: 3,
      linked: 8,
      feisAssigned: 2,
      reviews: { score_band: 0, second_fei: 0 },
      // Every notice and event but those of the test without a producer.
      noticesUpdated: 8,
      eventsUpdated: 2,
      firmsRefreshed: 3,
      ms: expect.any(Number),
    });
    const dongwei = await firmOfFei(DONGWEI_FEI);
    const goldenHarvest = await firmOfFei(GOLDEN_HARVEST_FEI);
    const [{ id: vietnamese }] = await db.select({ id: firm.id }).from(firm).where(eq(firm.countryCode, 'VN'));
    expect(await recordFirms()).toEqual({
      [`fda_refusal/${refusals[0].key}`]: dongwei,
      [`fda_refusal/${refusals[1].key}`]: dongwei,
      [`fda_refusal/${refusals[2].key}`]: goldenHarvest,
      [`fda_refusal/${refusals[3].key}`]: goldenHarvest,
      [`import_alert/${listings[0].key}`]: dongwei,
      [`import_alert/${listings[1].key}`]: vietnamese,
      [`import_alert/${listings[2].key}`]: vietnamese,
      [`au_ifis/${auRows[0].key}`]: dongwei,
      [`au_ifis/${auRows[1].key}`]: null,
    });
    // The same run gave the firms their alternative names and facts.
    expect(
      await db
        .select({ displayName: firm.displayName, altNames: firm.altNames, metrics: firm.metrics })
        .from(firm)
        .where(eq(firm.id, dongwei)),
    ).toEqual([
      {
        displayName: 'FUJIAN DONGWEI FOOD CO., LTD.',
        altNames: ['FUJIAN DONGWEI FOOD CO LTD', 'FUJIAN DONGWEI FOOD CO.,LTD'],
        metrics: {
          fda_refusals_total: 2,
          au_failed_total: 1,
          import_alert_red_current: 1,
          import_alert_green_current: 0,
        },
      },
    ]);
  });

  it('never links across countries', async () => {
    await insertFixture();

    await linkEntities(db, { today: TODAY });

    // One name, two countries, two firms.
    expect(
      await db
        .select({ countryCode: firm.countryCode })
        .from(firm)
        .where(eq(firm.nameNorm, 'golden harvest foods'))
        .orderBy(asc(firm.countryCode)),
    ).toEqual([{ countryCode: 'TH' }, { countryCode: 'VN' }]);
    const { rows } = await db.execute<{ firms: number }>(sql`
      select count(*)::int as firms from (
        select firm_id from (
          select firm_id, country_code from fda_refusal
          union all
          select firm_id, country_code from import_alert_listing
          union all
          select firm_id, country_code from au_failing_food
        ) records
        where firm_id is not null
        group by firm_id
        having count(distinct country_code) > 1
      ) mixed`);
    expect(rows).toEqual([{ firms: 0 }]);
  });

  it('does nothing the second time', async () => {
    await insertFixture();
    expect((await linkEntities(db, { today: TODAY })).linked).toBe(8);

    expect(await linkEntities(db, { today: TODAY })).toEqual({ ...NOTHING, ms: expect.any(Number) });
  });

  it('still re-points events and refreshes facts when there is nothing to link', async () => {
    const { listings } = await insertFixture();
    await linkEntities(db, { today: TODAY });
    // A later sync writes an event about a linked listing, without a firm.
    const event = await insertEvent(db, {
      source: 'import_alert',
      sourceKey: listings[0].key,
      noticeId: listings[0].noticeId,
    });

    // A year on, both FEI firms have no refusal within 12 months; the Vietnamese firm's facts don't depend on the day.
    expect(await linkEntities(db, { today: '2027-10-22' })).toEqual({
      ...NOTHING,
      eventsUpdated: 1,
      firmsRefreshed: 2,
      ms: expect.any(Number),
    });

    const [{ firmId }] = await db
      .select({ firmId: changeEvent.firmId })
      .from(changeEvent)
      .where(eq(changeEvent.id, event));
    expect(firmId).toBe(await firmOfFei(DONGWEI_FEI));
  });

  // Review Focus 3.
  it('never offers a merged-away firm', async () => {
    await insertFixture();
    await linkEntities(db, { today: TODAY });
    // Hanil Seafood was merged into the older Busan Marine Products, whose name is nothing like it.
    const kept = await insertFirm(db, { displayName: 'Busan Marine Products', countryCode: 'KR', city: 'busan' });
    const mergedAway = await insertFirm(db, {
      displayName: 'Hanil Seafood Co., Ltd.',
      countryCode: 'KR',
      city: 'busan',
      addressNorm: '25 haeun daero',
      commodityIds: [1003],
    });
    await db.insert(firmAlias).values({ oldId: mergedAway, newId: kept });
    // A new listing that matches the merged-away firm exactly: distinctive name, address, city and commodity.
    const listing = await insertListing(
      db,
      {
        firmName: 'HANIL SEAFOOD CO., LTD.',
        addressRaw: '25 Haeun-daero, BUSAN KOREA, REPUBLIC OF (SOUTH)',
        city: 'BUSAN',
        countryCode: 'KR',
        countryName: 'KOREA, REPUBLIC OF (SOUTH)',
        listedOn: '2026-09-01',
      },
      { notice: { commodityId: 1003 } },
    );

    const result = await linkEntities(db, { today: TODAY });

    // The listing gets a firm of its own, and no review proposes the merged-away firm.
    expect(result).toMatchObject({ firmsCreated: 1, linked: 1, reviews: { score_band: 0, second_fei: 0 } });
    const [{ firmId }] = await db
      .select({ firmId: importAlertListing.firmId })
      .from(importAlertListing)
      .where(eq(importAlertListing.listingKey, listing.key));
    expect(firmId).not.toBeNull();
    expect(firmId).not.toBe(mergedAway);
    expect(await db.select({ id: matchReview.id }).from(matchReview)).toEqual([]);
    // Nor are its facts refreshed.
    const [{ flags }] = await db.select({ flags: firm.flags }).from(firm).where(eq(firm.id, mergedAway));
    expect(flags).toEqual({});
  });
});
