import type { FirmFlags, FirmMetrics } from '@rejectradar/contracts';
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
import { eq } from 'drizzle-orm';
import { refreshFirmAggregates } from './aggregates';
import { refreshFirmAltNames } from './alt-names';
import { insertAuRow, insertFirm, insertListing, insertRefusal } from './testing';

/** The windows end here: within 12 months is after 2025-10-22, within 3 years after 2023-10-22. */
const TODAY = '2026-10-22';

describe('refreshFirmAggregates and refreshFirmAltNames', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Database;

  beforeAll(async () => {
    pool = createPool(await prepareTestDatabase('entities_facts'));
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

  async function factsOf(id: number) {
    const [row] = await db
      .select({
        commodityIds: firm.commodityIds,
        firstSeen: firm.firstSeen,
        lastNoticeOn: firm.lastNoticeOn,
        flags: firm.flags,
        metrics: firm.metrics,
      })
      .from(firm)
      .where(eq(firm.id, id));
    return row;
  }

  async function altNamesOf(id: number): Promise<string[]> {
    const [row] = await db.select({ altNames: firm.altNames }).from(firm).where(eq(firm.id, id));
    return row.altNames;
  }

  /** Gurudev Spices with a record of every kind; the comments say what each adds to the facts on TODAY. */
  async function insertGurudev(): Promise<number> {
    const gurudev = await insertFirm(db, { displayName: 'Gurudev Spices', countryCode: 'IN' });
    const of = { firmId: gurudev, countryCode: 'IN' };

    // Refusals 13 months and 2 months before TODAY, and two on a window's first excluded day: exactly 3 years and
    // exactly 12 months before. The latest carries two contaminant hazards.
    await insertRefusal(db, { ...of, refusalDate: '2023-10-22', commodityId: 204, hazardIds: [800] });
    await insertRefusal(db, { ...of, refusalDate: '2025-09-22', commodityId: 202, hazardIds: [100, 1200] });
    await insertRefusal(db, { ...of, refusalDate: '2025-10-22' });
    await insertRefusal(db, { ...of, refusalDate: '2026-08-22', hazardIds: [600, 601, 1200] });

    // Current red listings on food alerts: two on 99-08 (mycotoxins and pathogens on the first notice) and an undated
    // one on 16-120 (pathogens), first seen after every other record with a notice.
    await insertListing(
      db,
      { ...of, alertNumber: '99-08', listedOn: '2024-07-08' },
      { notice: { commodityId: 201, hazardIds: [300, 400] } },
    );
    await insertListing(db, { ...of, alertNumber: '99-08', listedOn: '2023-02-14' }, { notice: true });
    await insertListing(
      db,
      { ...of, alertNumber: '16-120', firstSeenOn: '2026-09-15', lastSeenOn: '2026-10-20' },
      { notice: { hazardIds: [401] } },
    );
    // Red listings that are not current: one removed, one on an alert FDA has removed. Their notices still name
    // commodities, but their additive hazards don't count.
    await insertListing(
      db,
      { ...of, alertNumber: '99-19', listedOn: '2019-05-02', removedOn: '2023-01-10' },
      { notice: { commodityId: 205, hazardIds: [700] } },
    );
    await insertListing(
      db,
      { ...of, alertNumber: '45-02', listedOn: '2020-11-03' },
      { alert: { removedAt: new Date('2026-09-30T00:00:00Z') }, notice: { commodityId: 203, hazardIds: [701] } },
    );
    // Green listings, without notices: a current one on 16-120, the latest record of all, and one on a non-food alert,
    // the earliest.
    await insertListing(db, { ...of, list: 'green', alertNumber: '16-120', listedOn: '2026-10-01' });
    await insertListing(
      db,
      { ...of, list: 'green', alertNumber: '66-40', firstSeenOn: '2016-02-01' },
      { alert: { isFood: false } },
    );

    // Australian failed tests: two dated by the same report month, of which the later key (the latest) was a
    // holding-order match; and one that failed exactly 3 years before TODAY, reported a month later. The match is
    // stored neither first nor last.
    await insertAuRow(db, { ...of, sourceKey: 'au-2026-07-a', reportMonth: '2026-07-01', holdingOrderMatch: false });
    await insertAuRow(db, {
      ...of,
      sourceKey: 'au-2026-07-b',
      reportMonth: '2026-07-01',
      holdingOrderMatch: true,
      commodityId: 202,
      hazardIds: [400, 100, 1200],
    });
    await insertAuRow(db, {
      ...of,
      failedOn: '2023-10-22',
      reportMonth: '2023-11-01',
      holdingOrderMatch: false,
      commodityId: 1002,
      hazardIds: [100],
    });
    return gurudev;
  }

  it('computes the facts a hand calculation gives', async () => {
    const gurudev = await insertGurudev();

    expect(await refreshFirmAggregates(db, { today: TODAY })).toBe(1);

    const flags: FirmFlags = {
      // 16-120 has no listing date; 99-08 takes the earlier of its two.
      import_alert_red: [
        { alert: '16-120', listed_on: null },
        { alert: '99-08', listed_on: '2023-02-14' },
      ],
      import_alert_green: [{ alert: '16-120', listed_on: '2026-10-01' }],
      fda_refusals_12m: 1,
      fda_refusals_3y: 3,
      au_failed_3y: 2,
      au_holding_order: true,
      // Pathogens 3 (two current red listings and the holding-order test), pesticide residues 2 (the 13-month refusal
      // and that test), contaminants 1 (two hazards of one refusal) and mycotoxins 1, which loses the tie by name.
      // Unclassified (3 records) never counts.
      top_hazards_3y: ['pathogens', 'pesticide_residues', 'contaminants'],
    };
    const metrics: FirmMetrics = {
      fda_refusals_total: 4,
      au_failed_total: 3,
      import_alert_red_current: 2,
      import_alert_green_current: 1,
    };
    expect(await factsOf(gurudev)).toEqual({
      // Refusals, every red listing's notice and Australian tests, each commodity once.
      commodityIds: [201, 202, 203, 204, 205, 1002],
      // The green listing on the non-food alert.
      firstSeen: '2016-02-01',
      // The undated red listing, by its first sighting; the later green listing has no notice.
      lastNoticeOn: '2026-09-15',
      flags,
      metrics,
    });
  });

  // Review Focus 4.
  it('ages 12-month counts without new records', async () => {
    const gurudev = await insertGurudev();
    await refreshFirmAggregates(db, { today: TODAY });
    expect((await factsOf(gurudev)).flags).toMatchObject({ fda_refusals_12m: 1, fda_refusals_3y: 3 });

    // A year later the refusal from 2 months before TODAY is 14 months old; the same 3 refusals are within 3 years.
    expect(await refreshFirmAggregates(db, { today: '2027-10-22' })).toBe(1);

    expect((await factsOf(gurudev)).flags).toMatchObject({ fda_refusals_12m: 0, fda_refusals_3y: 3 });
  });

  it('writes only firms whose facts changed', async () => {
    const gurudev = await insertGurudev();
    const empty = await insertFirm(db, { displayName: 'Seoul Foods', countryCode: 'KR' });
    const mergedAway = await insertFirm(db, { displayName: 'Gurudev Spice Mills', countryCode: 'IN' });
    await db.insert(firmAlias).values({ oldId: mergedAway, newId: gurudev });

    // Only the firm asked for. A firm without records gets empty lists, zero counts, false and no dates.
    expect(await refreshFirmAggregates(db, { today: TODAY, firmIds: [empty] })).toBe(1);
    expect(await factsOf(empty)).toEqual({
      commodityIds: [],
      firstSeen: null,
      lastNoticeOn: null,
      flags: {
        import_alert_red: [],
        import_alert_green: [],
        fda_refusals_12m: 0,
        fda_refusals_3y: 0,
        au_failed_3y: 0,
        au_holding_order: false,
        top_hazards_3y: [],
      } satisfies FirmFlags,
      metrics: {
        fda_refusals_total: 0,
        au_failed_total: 0,
        import_alert_red_current: 0,
        import_alert_green_current: 0,
      } satisfies FirmMetrics,
    });
    expect((await factsOf(gurudev)).flags).toEqual({});

    // Every firm not merged away: only Gurudev Spices has changed now, and nothing has the second time.
    expect(await refreshFirmAggregates(db, { today: TODAY })).toBe(1);
    expect(await refreshFirmAggregates(db, { today: TODAY })).toBe(0);
    expect((await factsOf(mergedAway)).flags).toEqual({});
  });

  it('keeps other usable raw names and drops legal-only names and the display name', async () => {
    const gurudev = await insertFirm(db, { displayName: 'Gurudev Spices Pvt. Ltd.', countryCode: 'IN' });
    const other = await insertFirm(db, { displayName: 'Seoul Foods', countryCode: 'KR' });
    const of = { firmId: gurudev, countryCode: 'IN' };
    // The display name in capitals, and a name made only of legal-form words.
    await insertRefusal(db, { ...of, firmName: 'GURUDEV SPICES PVT. LTD.' });
    await insertRefusal(db, { ...of, firmName: 'PVT. LTD.' });
    // One name spelt two ways: the refusal's spelling is seen first (refusals, then listings, then Australian tests).
    await insertListing(db, { ...of, firmName: 'GURUDEV SPICES PRIVATE LIMITED' });
    await insertRefusal(db, { ...of, firmName: 'Gurudev Spices Private Limited' });
    await insertListing(db, { ...of, firmName: 'GURUDEV SPICE MILLS' });
    await insertAuRow(db, { ...of, producerName: 'M/S Gurudev Exports' });
    await insertAuRow(db, { ...of, producerName: 'Co., Ltd.' });
    await insertAuRow(db, { ...of, producerName: null });
    await insertRefusal(db, { firmId: other, firmName: 'Seoul Foods Co., Ltd.', countryCode: 'KR' });

    expect(await refreshFirmAltNames(db, [gurudev])).toBe(1);

    expect(await altNamesOf(gurudev)).toEqual([
      'GURUDEV SPICE MILLS',
      'Gurudev Spices Private Limited',
      'M/S Gurudev Exports',
    ]);
    expect(await altNamesOf(other)).toEqual([]);
    // Unchanged names are not written again.
    expect(await refreshFirmAltNames(db, [gurudev])).toBe(0);
  });

  it('keeps the first 20 alternative names in code-unit order', async () => {
    const gurudev = await insertFirm(db, { displayName: 'Gurudev Spices', countryCode: 'IN' });
    const unit = (n: number): string => `Gurudev Spices Unit ${String(n).padStart(2, '0')}`;
    // Stored from the last unit down, so storage order would keep a different 20.
    for (let n = 21; n >= 1; n--) await insertRefusal(db, { firmId: gurudev, firmName: unit(n), countryCode: 'IN' });

    expect(await refreshFirmAltNames(db, [gurudev])).toBe(1);

    expect(await altNamesOf(gurudev)).toEqual(Array.from({ length: 20 }, (_, i) => unit(i + 1)));
  });
});
