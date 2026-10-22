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
import { asc, inArray } from 'drizzle-orm';
import { applyLinkPlan, propagateFirmIds } from './apply';
import { loadLinkInput } from './load';
import { insertAuRow, insertEvent, insertFirm, insertListing, insertRefusal } from './testing';
import type { FirmRef, LinkPlan, ReviewDraft } from './types';

const existing = (id: number): FirmRef => ({ kind: 'existing', id });
const created = (index: number): FirmRef => ({ kind: 'new', index });

describe('loadLinkInput, applyLinkPlan and propagateFirmIds', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Database;

  beforeAll(async () => {
    pool = createPool(await prepareTestDatabase('entities_apply'));
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

  /** firm_id of every notice, by source and key. */
  async function noticeFirms(): Promise<Record<string, number | null>> {
    const rows = await db.select({ source: notice.source, key: notice.sourceKey, firmId: notice.firmId }).from(notice);
    return Object.fromEntries(rows.map(({ source, key, firmId }) => [`${source}/${key}`, firmId]));
  }

  /** firm_id of every change event, by id. */
  async function eventFirms(): Promise<Record<number, number | null>> {
    const rows = await db.select({ id: changeEvent.id, firmId: changeEvent.firmId }).from(changeEvent);
    return Object.fromEntries(rows.map(({ id, firmId }) => [id, firmId]));
  }

  it('loads only unlinked records, skips Australian rows without a producer and merged-away firms', async () => {
    const dongwei = await insertFirm(db, {
      displayName: 'Fujian Dongwei Food Co., Ltd.',
      countryCode: 'CN',
      region: 'fujian',
      city: 'fuqing',
      addressNorm: '5 fulu centre road',
      commodityIds: [1001, 1002],
    });
    await db.insert(firmFei).values([
      { fei: 3009876543, firmId: dongwei },
      { fei: 3001234567, firmId: dongwei },
    ]);
    const gurudev = await insertFirm(db, { displayName: 'Gurudev Spices' });
    const mergedAway = await insertFirm(db, { displayName: 'Fujian Dongwei Foods', countryCode: 'CN' });
    await db.insert(firmAlias).values({ oldId: mergedAway, newId: dongwei });

    const refusal = await insertRefusal(db, {
      fei: 3001234567,
      firmName: 'FUJIAN DONGWEI FOOD CO., LTD.',
      addressLine1: 'NO.5 Fulu Centre Road',
      addressLine2: 'Long Tian Economic Development Area',
      city: 'FUQING',
      region: 'Fujian',
      postalCode: '350300',
      countryCode: 'CN',
      commodityId: 1001,
      refusalDate: '2025-04-03',
    });
    const bareRefusal = await insertRefusal(db, {
      firmName: 'Gurudev Spices',
      countryCode: 'IN',
      refusalDate: '2025-05-06',
    });
    await insertRefusal(db, { firmName: 'Gurudev Spices', countryCode: 'IN', firmId: gurudev, linkScore: '1' });
    const listing = await insertListing(db, { firmName: 'GURUDEV SPICES', countryCode: 'IN', listedOn: '2024-07-08' });
    await insertListing(db, { firmName: 'GURUDEV SPICES', countryCode: 'IN', firmId: gurudev, linkScore: '0.9500' });
    const auRow = await insertAuRow(db, {
      producerName: 'Viet Seafood Co.',
      countryCode: 'VN',
      commodityId: 1001,
      reportMonth: '2026-02-01',
      failedOn: '2026-02-03',
    });
    const auMonthOnly = await insertAuRow(db, {
      producerName: 'Viet Seafood Co.',
      countryCode: 'VN',
      reportMonth: '2026-03-01',
    });
    await insertAuRow(db, { producerName: null, countryCode: 'VN' });
    // A producer written only in another script normalises to nothing: there is no name to link.
    await insertAuRow(db, { producerName: '越南海鲜', countryCode: 'VN' });
    await insertAuRow(db, { producerName: 'Viet Seafood Co.', countryCode: 'VN', firmId: gurudev, linkScore: '1' });

    const { firms, records } = await loadLinkInput(db);

    expect(firms).toEqual([
      {
        id: dongwei,
        nameNorm: 'fujian dongwei food',
        address: {
          countryCode: 'CN',
          region: 'fujian',
          city: 'fuqing',
          postalCode: null,
          addressNorm: '5 fulu centre road',
        },
        commodityIds: [1001, 1002],
        feis: [3001234567, 3009876543],
      },
      { id: gurudev, nameNorm: 'gurudev spices', address: null, commodityIds: [], feis: [] },
    ]);
    const countryOnly = (countryCode: string) => ({
      countryCode,
      region: null,
      city: null,
      postalCode: null,
      addressNorm: null,
    });
    expect(records).toEqual([
      {
        source: 'fda_refusal',
        key: refusal.key,
        fei: 3001234567,
        firmName: 'FUJIAN DONGWEI FOOD CO., LTD.',
        nameNorm: 'fujian dongwei food',
        address: {
          countryCode: 'CN',
          region: 'fujian',
          city: 'fuqing',
          postalCode: '350300',
          addressNorm: '5 fulu centre road long tian economic development area',
        },
        commodityIds: [1001],
        seenOn: '2025-04-03',
      },
      {
        source: 'fda_refusal',
        key: bareRefusal.key,
        fei: null,
        firmName: 'Gurudev Spices',
        nameNorm: 'gurudev spices',
        address: countryOnly('IN'),
        commodityIds: [],
        seenOn: '2025-05-06',
      },
      {
        source: 'import_alert',
        key: listing.key,
        fei: null,
        firmName: 'GURUDEV SPICES',
        nameNorm: 'gurudev spices',
        address: countryOnly('IN'),
        commodityIds: [],
        seenOn: '2024-07-08',
      },
      {
        source: 'au_ifis',
        key: auRow.key,
        fei: null,
        firmName: 'Viet Seafood Co.',
        nameNorm: 'viet seafood',
        address: countryOnly('VN'),
        commodityIds: [1001],
        seenOn: '2026-02-03',
      },
      {
        source: 'au_ifis',
        key: auMonthOnly.key,
        fei: null,
        firmName: 'Viet Seafood Co.',
        nameNorm: 'viet seafood',
        address: countryOnly('VN'),
        commodityIds: [],
        seenOn: '2026-03-01',
      },
    ]);
  });

  it('gives an FEI left on a merged-away firm to the firm it was merged into', async () => {
    const dongwei = await insertFirm(db, { displayName: 'Fujian Dongwei Food Co., Ltd.', countryCode: 'CN' });
    const mergedAway = await insertFirm(db, { displayName: 'Fujian Dongwei Foods', countryCode: 'CN' });
    await db.insert(firmAlias).values({ oldId: mergedAway, newId: dongwei });
    // A firm_fei row that still names the merged-away firm. Dropped, its FEI would look new to a run, which would give
    // it another firm.
    await db.insert(firmFei).values([
      { fei: 3009876543, firmId: dongwei },
      { fei: 3001234567, firmId: mergedAway },
    ]);

    const { firms } = await loadLinkInput(db);

    expect(firms).toEqual([
      {
        id: dongwei,
        nameNorm: 'fujian dongwei food',
        address: { countryCode: 'CN', region: null, city: null, postalCode: null, addressNorm: null },
        commodityIds: [],
        feis: [3001234567, 3009876543],
      },
    ]);
  });

  it('counts the names of every record, linked or not, and of every firm not merged away (P3-D4)', async () => {
    const dongwei = await insertFirm(db, { displayName: 'Fujian Dongwei Food Co., Ltd.', countryCode: 'CN' });
    const mergedAway = await insertFirm(db, { displayName: 'Fujian Dongwei Foods', countryCode: 'CN' });
    await db.insert(firmAlias).values({ oldId: mergedAway, newId: dongwei });
    await insertFirm(db, { displayName: 'Gurudev Spice Mills', countryCode: 'IN' });
    // Linked records, under names their firm does not have.
    await insertRefusal(db, { firmName: 'DONGWEI FOODSTUFF', countryCode: 'CN', firmId: dongwei, linkScore: '0.9100' });
    await insertListing(db, { firmName: 'Fujian Dongwei', countryCode: 'CN', firmId: dongwei, linkScore: '0.9500' });
    await insertAuRow(db, {
      producerName: 'Dongwei Food Co.',
      countryCode: 'CN',
      firmId: dongwei,
      linkScore: '0.9200',
    });
    // Unlinked records; a name given twice in a country counts once, in each country it is given in.
    await insertRefusal(db, { firmName: 'Gurudev Spices', countryCode: 'IN' });
    await insertListing(db, { firmName: 'GURUDEV SPICES', countryCode: 'IN' });
    await insertAuRow(db, { producerName: 'Gurudev Spices Pvt Ltd', countryCode: 'NP' });
    // No name: an Australian test without a producer, or with one written only in another script.
    await insertAuRow(db, { producerName: null, countryCode: 'VN' });
    await insertAuRow(db, { producerName: '越南海鲜', countryCode: 'VN' });

    const { frequencyNames } = await loadLinkInput(db);

    // In no particular order: by country, then name.
    const byCountryAndName = [...frequencyNames].sort(
      (a, b) => `${a.countryCode}`.localeCompare(`${b.countryCode}`) || (a.nameNorm < b.nameNorm ? -1 : 1),
    );
    expect(byCountryAndName).toEqual([
      { countryCode: 'CN', nameNorm: 'dongwei food' },
      { countryCode: 'CN', nameNorm: 'dongwei foodstuff' },
      { countryCode: 'CN', nameNorm: 'fujian dongwei' },
      { countryCode: 'CN', nameNorm: 'fujian dongwei food' },
      { countryCode: 'IN', nameNorm: 'gurudev spice mills' },
      { countryCode: 'IN', nameNorm: 'gurudev spices' },
      { countryCode: 'NP', nameNorm: 'gurudev spices' },
    ]);
  });

  it('strips the Import Alert location tail and takes red-list commodities from the notice', async () => {
    const red = await insertListing(
      db,
      {
        firmName: 'FUJIAN DONGWEI FOOD CO., LTD.',
        addressRaw: 'NO.5 Fulu Centre Road,Long Tian Economic , Development Area, , FUQING, Fujian CHINA',
        city: 'FUQING',
        region: 'Fujian',
        countryCode: 'CN',
        countryName: 'CHINA',
        listedOn: '2024-07-08',
      },
      { notice: { commodityId: 1001 } },
    );
    const green = await insertListing(db, {
      list: 'green',
      firmName: 'Seoul Foods Co., Ltd.',
      addressRaw: '12 Gangnam-daero, SEOUL, Seoul KOREA, REPUBLIC OF (SOUTH)',
      city: 'SEOUL',
      region: 'Seoul',
      countryCode: 'KR',
      countryName: 'KOREA, REPUBLIC OF (SOUTH)',
      firstSeenOn: '2026-02-01',
    });
    // A notice of another source under the green listing's key is not the listing's.
    await insertRefusal(db, { sourceKey: green.key, commodityId: 202 }, { notice: true });

    const { records } = await loadLinkInput(db);

    expect(records.filter(({ source }) => source === 'import_alert')).toEqual([
      {
        source: 'import_alert',
        key: red.key,
        fei: null,
        firmName: 'FUJIAN DONGWEI FOOD CO., LTD.',
        nameNorm: 'fujian dongwei food',
        address: {
          countryCode: 'CN',
          region: 'fujian',
          city: 'fuqing',
          postalCode: null,
          addressNorm: '5 fulu centre road long tian economic development area',
        },
        commodityIds: [1001],
        seenOn: '2024-07-08',
      },
      {
        source: 'import_alert',
        key: green.key,
        fei: null,
        firmName: 'Seoul Foods Co., Ltd.',
        nameNorm: 'seoul foods',
        address: {
          countryCode: 'KR',
          region: 'seoul',
          city: 'seoul',
          postalCode: null,
          addressNorm: '12 gangnam daero',
        },
        commodityIds: [],
        seenOn: '2026-02-01',
      },
    ]);
  });

  it('applies a plan: firms, FEIs, record links and reviews', async () => {
    const gurudev = await insertFirm(db, { displayName: 'Gurudev Spices', countryCode: 'IN' });
    const feiHolder = await insertFirm(db, { displayName: 'Dongwei Foods', countryCode: 'CN' });
    const candidate = await insertFirm(db, { displayName: 'Viet Sea Food', countryCode: 'VN' });
    const other = await insertFirm(db, { displayName: 'Gurudev Spice Mills', countryCode: 'IN' });

    const first = await insertRefusal(db, {
      fei: 3001234567,
      firmName: 'FUJIAN DONGWEI FOOD CO., LTD.',
      countryCode: 'CN',
    });
    const second = await insertRefusal(db, {
      fei: 3001234567,
      firmName: 'FUJIAN DONGWEI FOOD CO., LTD.',
      countryCode: 'CN',
    });
    const listing = await insertListing(db, { firmName: 'GURUDEV SPICES', countryCode: 'IN' });
    const auRow = await insertAuRow(db, { producerName: 'Viet Seafood Co.', countryCode: 'VN' });
    // Linked elsewhere between loading and applying: the plan leaves it as it is.
    const taken = await insertAuRow(db, {
      producerName: 'Gurudev Spices',
      countryCode: 'IN',
      firmId: other,
      linkScore: '0.9700',
    });

    const evidence: ReviewDraft['evidence'] = {
      nameSim: 1,
      sameCountry: true,
      addressMatch: false,
      exactDistinctiveName: false,
      postalMatch: false,
      cityMatch: false,
      regionMatch: false,
      productOverlap: true,
      parts: { name: 0.75, location: 0.03, locationReason: 'same_country', product: 0.03, total: 0.81 },
    };
    const plan: LinkPlan = {
      newFirms: [
        {
          index: 0,
          displayName: 'FUJIAN DONGWEI FOOD CO., LTD.',
          nameNorm: 'fujian dongwei food',
          address: {
            countryCode: 'CN',
            region: 'fujian',
            city: 'fuqing',
            postalCode: '350300',
            addressNorm: '5 fulu centre road',
          },
          firstSeen: '2025-04-03',
          source: 'fda_refusal',
          key: second.key,
        },
        {
          index: 1,
          displayName: 'Viet Seafood Co.',
          nameNorm: 'viet seafood',
          address: null,
          firstSeen: '2026-02-03',
          source: 'au_ifis',
          key: auRow.key,
        },
      ],
      links: [
        { source: 'fda_refusal', key: first.key, firm: created(0), score: 1 },
        { source: 'fda_refusal', key: second.key, firm: created(0), score: 1 },
        { source: 'import_alert', key: listing.key, firm: existing(gurudev), score: 0.9123 },
        { source: 'au_ifis', key: auRow.key, firm: created(1), score: 1 },
        { source: 'au_ifis', key: taken.key, firm: existing(gurudev), score: 0.95 },
      ],
      feis: [
        { fei: 3001234567, firm: created(0), firstSeen: '2025-04-03' },
        { fei: 3007654321, firm: existing(feiHolder), firstSeen: '2024-01-02' },
      ],
      reviews: [
        {
          source: 'au_ifis',
          key: auRow.key,
          firm: created(1),
          candidate: existing(candidate),
          score: 0.81,
          reason: 'score_band',
          evidence,
        },
      ],
    };

    const result = await db.transaction((tx) => applyLinkPlan(tx, plan));

    expect(result.firmIds).toHaveLength(2);
    const [dongwei, vietSeafood] = result.firmIds;
    // The new firms, and the existing ones that gained a link or an FEI; not the review's candidate.
    expect(result.touchedFirmIds).toEqual([gurudev, feiHolder, dongwei, vietSeafood].sort((a, b) => a - b));
    expect(
      await db
        .select({
          id: firm.id,
          displayName: firm.displayName,
          nameNorm: firm.nameNorm,
          countryCode: firm.countryCode,
          region: firm.region,
          city: firm.city,
          postalCode: firm.postalCode,
          addressNorm: firm.addressNorm,
          firstSeen: firm.firstSeen,
        })
        .from(firm)
        .where(inArray(firm.id, result.firmIds))
        .orderBy(asc(firm.id)),
    ).toEqual([
      {
        id: dongwei,
        displayName: 'FUJIAN DONGWEI FOOD CO., LTD.',
        nameNorm: 'fujian dongwei food',
        countryCode: 'CN',
        region: 'fujian',
        city: 'fuqing',
        postalCode: '350300',
        addressNorm: '5 fulu centre road',
        firstSeen: '2025-04-03',
      },
      {
        id: vietSeafood,
        displayName: 'Viet Seafood Co.',
        nameNorm: 'viet seafood',
        countryCode: null,
        region: null,
        city: null,
        postalCode: null,
        addressNorm: null,
        firstSeen: '2026-02-03',
      },
    ]);
    expect(await db.select().from(firmFei).orderBy(asc(firmFei.fei))).toEqual([
      { fei: 3001234567, firmId: dongwei, firstSeen: '2025-04-03' },
      { fei: 3007654321, firmId: feiHolder, firstSeen: '2024-01-02' },
    ]);
    expect(
      await db
        .select({ key: fdaRefusal.sourceKey, firmId: fdaRefusal.firmId, linkScore: fdaRefusal.linkScore })
        .from(fdaRefusal)
        .orderBy(asc(fdaRefusal.id)),
    ).toEqual([
      { key: first.key, firmId: dongwei, linkScore: '1.0000' },
      { key: second.key, firmId: dongwei, linkScore: '1.0000' },
    ]);
    expect(
      await db
        .select({
          key: importAlertListing.listingKey,
          firmId: importAlertListing.firmId,
          linkScore: importAlertListing.linkScore,
        })
        .from(importAlertListing),
    ).toEqual([{ key: listing.key, firmId: gurudev, linkScore: '0.9123' }]);
    expect(
      await db
        .select({ key: auFailingFood.sourceKey, firmId: auFailingFood.firmId, linkScore: auFailingFood.linkScore })
        .from(auFailingFood)
        .orderBy(asc(auFailingFood.id)),
    ).toEqual([
      { key: auRow.key, firmId: vietSeafood, linkScore: '1.0000' },
      { key: taken.key, firmId: other, linkScore: '0.9700' },
    ]);
    expect(
      await db
        .select({
          source: matchReview.source,
          sourceKey: matchReview.sourceKey,
          firmId: matchReview.firmId,
          candidateFirmId: matchReview.candidateFirmId,
          score: matchReview.score,
          reason: matchReview.reason,
          evidence: matchReview.evidence,
          status: matchReview.status,
        })
        .from(matchReview),
    ).toEqual([
      {
        source: 'au_ifis',
        sourceKey: auRow.key,
        firmId: vietSeafood,
        candidateFirmId: candidate,
        score: '0.8100',
        reason: 'score_band',
        evidence,
        status: 'open',
      },
    ]);
  });

  it('writes a plan larger than one batch', async () => {
    // 1,201 new firms take three firm batches (500 each); their 1,201 links take two record batches (1,000 each).
    const keys = Array.from({ length: 1201 }, (_, i) => `batch-${i}`);
    await db
      .insert(fdaRefusal)
      .values(
        keys.map((sourceKey) => ({ sourceKey, firmName: sourceKey, nameNorm: sourceKey, refusalDate: '2026-01-15' })),
      );
    const plan: LinkPlan = {
      newFirms: keys.map((key, index) => ({
        index,
        displayName: key,
        nameNorm: key,
        address: null,
        firstSeen: '2026-01-15',
        source: 'fda_refusal',
        key,
      })),
      links: keys.map((key, index) => ({ source: 'fda_refusal', key, firm: created(index), score: 1 })),
      feis: [],
      reviews: [],
    };

    const { firmIds } = await db.transaction((tx) => applyLinkPlan(tx, plan));

    const names = new Map(
      (await db.select({ id: firm.id, nameNorm: firm.nameNorm }).from(firm)).map((f) => [f.id, f.nameNorm]),
    );
    expect(firmIds.map((id) => names.get(id))).toEqual(keys);
    const refusals = await db.select({ key: fdaRefusal.sourceKey, firmId: fdaRefusal.firmId }).from(fdaRefusal);
    expect(refusals.filter(({ key, firmId }) => firmId === null || names.get(firmId) !== key)).toEqual([]);
  });

  // Review Focus 1.
  it('propagates firm_id to notices and events, including an event written after the link', async () => {
    const gurudev = await insertFirm(db, { displayName: 'Gurudev Spices', countryCode: 'IN' });
    const refusal = await insertRefusal(db, { firmName: 'Gurudev Spices', countryCode: 'IN' }, { notice: true });
    const listing = await insertListing(db, { firmName: 'GURUDEV SPICES', countryCode: 'IN' }, { notice: true });
    const auRow = await insertAuRow(db, { producerName: 'Viet Seafood Co.', countryCode: 'VN' }, { notice: true });
    const noProducer = await insertAuRow(db, { producerName: null, countryCode: 'VN' }, { notice: true });
    const refusalEvent = await insertEvent(db, {
      source: 'fda_refusal',
      sourceKey: refusal.key,
      noticeId: refusal.noticeId,
    });
    const listedEvent = await insertEvent(db, {
      source: 'import_alert',
      sourceKey: listing.key,
      noticeId: listing.noticeId,
    });
    const auEvent = await insertEvent(db, { source: 'au_ifis', sourceKey: auRow.key, noticeId: auRow.noticeId });
    const noProducerEvent = await insertEvent(db, {
      source: 'au_ifis',
      sourceKey: noProducer.key,
      noticeId: noProducer.noticeId,
    });
    // Another source's event under the refusal's key is about another record.
    const rasffEvent = await insertEvent(db, { source: 'rasff', sourceKey: refusal.key });
    const plan: LinkPlan = {
      newFirms: [
        {
          index: 0,
          displayName: 'Viet Seafood Co.',
          nameNorm: 'viet seafood',
          address: { countryCode: 'VN', region: null, city: null, postalCode: null, addressNorm: null },
          firstSeen: '2026-01-01',
          source: 'au_ifis',
          key: auRow.key,
        },
      ],
      links: [
        { source: 'fda_refusal', key: refusal.key, firm: existing(gurudev), score: 0.95 },
        { source: 'import_alert', key: listing.key, firm: existing(gurudev), score: 0.93 },
        { source: 'au_ifis', key: auRow.key, firm: created(0), score: 1 },
      ],
      feis: [],
      reviews: [],
    };

    const applied = await db.transaction((tx) => applyLinkPlan(tx, plan));

    const [vietSeafood] = applied.firmIds;
    expect(applied.propagated).toEqual({ notices: 3, events: 3 });
    expect(await noticeFirms()).toEqual({
      [`fda_refusal/${refusal.key}`]: gurudev,
      [`import_alert/${listing.key}`]: gurudev,
      [`au_ifis/${auRow.key}`]: vietSeafood,
      [`au_ifis/${noProducer.key}`]: null,
    });
    expect(await eventFirms()).toEqual({
      [refusalEvent]: gurudev,
      [listedEvent]: gurudev,
      [auEvent]: vietSeafood,
      [noProducerEvent]: null,
      [rasffEvent]: null,
    });

    // A later sync delists the firm: its event is written with firm_id null, after the listing was linked.
    const delistedEvent = await insertEvent(db, {
      source: 'import_alert',
      sourceKey: listing.key,
      kind: 'import_alert_delisted',
      noticeId: listing.noticeId,
    });
    expect(await db.transaction((tx) => propagateFirmIds(tx))).toEqual({ notices: 0, events: 1 });
    expect((await eventFirms())[delistedEvent]).toBe(gurudev);
    expect(await db.transaction((tx) => propagateFirmIds(tx))).toEqual({ notices: 0, events: 0 });
  });

  it('re-points a notice whose record moved to another firm', async () => {
    const before = await insertFirm(db, { displayName: 'Gurudev Spices', countryCode: 'IN' });
    const after = await insertFirm(db, { displayName: 'Gurudev Spice Mills', countryCode: 'IN' });
    // One record moved to another firm (a merge, a split or a relink); a sync cleared another's firm (P3-D8).
    const moved = await insertRefusal(
      db,
      { firmName: 'Gurudev Spice Mills', countryCode: 'IN', firmId: after },
      { notice: { firmId: before } },
    );
    const cleared = await insertListing(
      db,
      { firmName: 'GURUDEV SPICES', countryCode: 'IN' },
      { notice: { firmId: before } },
    );
    const kept = await insertAuRow(
      db,
      { producerName: 'Gurudev Spices', countryCode: 'IN', firmId: before },
      { notice: true },
    );
    const movedEvent = await insertEvent(db, {
      source: 'fda_refusal',
      sourceKey: moved.key,
      noticeId: moved.noticeId,
      firmId: before,
    });
    const clearedEvent = await insertEvent(db, {
      source: 'import_alert',
      sourceKey: cleared.key,
      noticeId: cleared.noticeId,
      firmId: before,
    });
    const keptEvent = await insertEvent(db, {
      source: 'au_ifis',
      sourceKey: kept.key,
      noticeId: kept.noticeId,
      firmId: before,
    });

    expect(await db.transaction((tx) => propagateFirmIds(tx))).toEqual({ notices: 2, events: 2 });

    expect(await noticeFirms()).toEqual({
      [`fda_refusal/${moved.key}`]: after,
      [`import_alert/${cleared.key}`]: null,
      [`au_ifis/${kept.key}`]: before,
    });
    expect(await eventFirms()).toEqual({ [movedEvent]: after, [clearedEvent]: null, [keptEvent]: before });
  });
});
