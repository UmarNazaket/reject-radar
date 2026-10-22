import type { FirmRecordSource } from '@rejectradar/contracts';
import {
  alert,
  auditLog,
  auFailingFood,
  bulkJob,
  bulkJobRow,
  changeEvent,
  createDb,
  createPool,
  type Database,
  dispute,
  fdaRefusal,
  firm,
  firmAlias,
  firmFei,
  importAlert,
  importAlertListing,
  lookupLog,
  matchReview,
  notice,
  org,
  prepareTestDatabase,
  watchlistItem,
} from '@rejectradar/db';
import { asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { linkEntities } from './link-entities';
import { mergeFirms, type RecordRef, splitFirm } from './merge-split';
import { type FixtureRecord, insertAuRow, insertEvent, insertFirm, insertListing, insertRefusal } from './testing';

const TODAY = '2026-10-22';
const ACTOR = randomUUID();
/** A reviewer who decided a review before the merge or split under test. */
const EARLIER_ACTOR = randomUUID();
const KEPT_FEI = 3001234567;
const MERGED_FEI = 3009876543;
/** Golden Harvest's FEIs: the split takes both refusals of the first, leaves the second, and the third has none. */
const SPLIT_FEI = 3007654321;
const STAYING_FEI = 3005555555;
const IDLE_FEI = 3009999999;

/** A record for splitFirm. */
const ref = (source: FirmRecordSource, { key }: FixtureRecord): RecordRef => ({ source, key });

/** `firmId` by `id`, of rows that have both. */
const firmsById = <K extends string | number>(rows: { id: K; firmId: number | null }[]) =>
  Object.fromEntries(rows.map(({ id, firmId }) => [id, firmId]));

/** An open review of a refusal's firm against a candidate, unless `fields` say otherwise. */
const review = (firmId: number, candidateFirmId: number, fields: Partial<typeof matchReview.$inferInsert> = {}) => ({
  source: 'fda_refusal',
  sourceKey: randomUUID(),
  firmId,
  candidateFirmId,
  score: '0.8100',
  ...fields,
});

describe('mergeFirms and splitFirm', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Database;

  beforeAll(async () => {
    pool = createPool(await prepareTestDatabase('entities_merge'));
    db = createDb(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    // An account takes its watchlists, lookups, alerts, bulk jobs and disputes with it. Then the rows that reference a
    // firm (or a notice) go first.
    for (const table of [
      org,
      auditLog,
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

  async function insertOrg(id: string = randomUUID()): Promise<string> {
    await db.insert(org).values({ id, name: `Account ${id}` });
    return id;
  }

  /** An account's watchlist item on a firm. */
  async function watch(
    orgId: string,
    firmId: number,
    fields: Partial<typeof watchlistItem.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(watchlistItem)
      .values({ id: randomUUID(), orgId, kind: 'firm', firmId, ...fields })
      .returning({ id: watchlistItem.id });
    return row.id;
  }

  async function insertAlert(orgId: string, changeEventId: number, firmId: number): Promise<string> {
    const id = randomUUID();
    await db.insert(alert).values({ id, orgId, changeEventId, firmId, severity: 'high' });
    return id;
  }

  /** A dispute about the firm, or about one of its records when `record` names it. */
  async function insertDispute(orgId: string, firmId: number, record?: RecordRef): Promise<string> {
    const id = randomUUID();
    await db
      .insert(dispute)
      .values({ id, orgId, firmId, source: record?.source, sourceKey: record?.key, message: 'Not our firm' });
    return id;
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

  /** firm_id of every notice, by source and key. */
  async function noticeFirms(): Promise<Record<string, number | null>> {
    const rows = await db.select({ source: notice.source, key: notice.sourceKey, firmId: notice.firmId }).from(notice);
    return Object.fromEntries(rows.map(({ source, key, firmId }) => [`${source}/${key}`, firmId]));
  }

  async function eventFirms(): Promise<Record<number, number | null>> {
    return firmsById(await db.select({ id: changeEvent.id, firmId: changeEvent.firmId }).from(changeEvent));
  }

  async function feiFirms(): Promise<Record<number, number | null>> {
    return firmsById(await db.select({ id: firmFei.fei, firmId: firmFei.firmId }).from(firmFei));
  }

  /** new_id by old_id. */
  async function aliases(): Promise<Record<number, number>> {
    const rows = await db.select({ oldId: firmAlias.oldId, newId: firmAlias.newId }).from(firmAlias);
    return Object.fromEntries(rows.map(({ oldId, newId }) => [oldId, newId]));
  }

  async function auditRows() {
    return db
      .select({
        actorUserId: auditLog.actorUserId,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        details: auditLog.details,
      })
      .from(auditLog)
      .orderBy(asc(auditLog.id));
  }

  /** A firm's name, address and the facts a refresh writes. */
  async function firmView(id: number) {
    const [row] = await db
      .select({
        displayName: firm.displayName,
        nameNorm: firm.nameNorm,
        countryCode: firm.countryCode,
        region: firm.region,
        city: firm.city,
        postalCode: firm.postalCode,
        addressNorm: firm.addressNorm,
        firstSeen: firm.firstSeen,
        altNames: firm.altNames,
        metrics: firm.metrics,
      })
      .from(firm)
      .where(eq(firm.id, id));
    return row;
  }

  /** A review's decision, with `decided_at` as text, to the microsecond. */
  async function decisionOf(id: number) {
    const { rows } = await db.execute<{ status: string; decidedBy: string | null; decidedAt: string | null }>(sql`
      select status, decided_by as "decidedBy", decided_at::text as "decidedAt" from match_review where id = ${id}`);
    return rows[0];
  }

  /** Per foreign key on firm.id, as table.column, how many rows point at `firmId`; only the keys that have any. */
  async function referencesTo(firmId: number): Promise<Record<string, number>> {
    const { rows: keys } = await db.execute<{ table: string; column: string }>(sql`
      select c.conrelid::regclass::text as table, a.attname as column
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'firm'::regclass`);
    const counts: Record<string, number> = {};
    for (const { table, column } of keys) {
      const { rows } = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from ${sql.identifier(table)} where ${sql.identifier(column)} = ${firmId}`,
      );
      if (rows[0].count > 0) counts[`${table}.${column}`] = rows[0].count;
    }
    return counts;
  }

  describe('mergeFirms', () => {
    const merge = (firmIds: readonly [number, number]) => mergeFirms(db, { firmIds, actorUserId: ACTOR, today: TODAY });

    it('merge keeps the older id and re-points records, notices, events and FEIs', async () => {
      const kept = await insertFirm(db, { displayName: 'Fujian Dongwei Food Co., Ltd.', countryCode: 'CN' });
      const merged = await insertFirm(db, { displayName: 'Fujian Dongwei Foods', countryCode: 'CN' });
      await db.insert(firmFei).values([
        { fei: KEPT_FEI, firmId: kept },
        { fei: MERGED_FEI, firmId: merged },
      ]);
      const keptRefusal = await insertRefusal(
        db,
        { fei: KEPT_FEI, firmName: 'FUJIAN DONGWEI FOOD CO., LTD.', countryCode: 'CN', firmId: kept },
        { notice: true },
      );
      const refusal = await insertRefusal(
        db,
        { fei: MERGED_FEI, firmName: 'FUJIAN DONGWEI FOODS', countryCode: 'CN', firmId: merged },
        { notice: true },
      );
      const listing = await insertListing(
        db,
        { firmName: 'Fujian Dongwei Foods', countryCode: 'CN', firmId: merged },
        { notice: true },
      );
      const auRow = await insertAuRow(
        db,
        { producerName: 'FUJIAN DONGWEI FOOD CO.,LTD', countryCode: 'CN', firmId: merged },
        { notice: true },
      );
      const keptEvent = await insertEvent(db, { source: 'fda_refusal', sourceKey: keptRefusal.key, firmId: kept });
      const event = await insertEvent(db, { source: 'fda_refusal', sourceKey: refusal.key, firmId: merged });

      // The newer firm comes first: the order of the two ids does not matter.
      const result = await merge([merged, kept]);

      expect(result).toEqual({
        keptId: kept,
        mergedId: merged,
        moved: {
          fda_refusal: 1,
          import_alert_listing: 1,
          au_failing_food: 1,
          notice: 3,
          change_event: 1,
          firm_fei: 1,
          firm_alias: 1,
        },
      });
      const everyRecord = {
        [`fda_refusal/${keptRefusal.key}`]: kept,
        [`fda_refusal/${refusal.key}`]: kept,
        [`import_alert/${listing.key}`]: kept,
        [`au_ifis/${auRow.key}`]: kept,
      };
      expect(await recordFirms()).toEqual(everyRecord);
      expect(await noticeFirms()).toEqual(everyRecord);
      expect(await eventFirms()).toEqual({ [keptEvent]: kept, [event]: kept });
      expect(await feiFirms()).toEqual({ [KEPT_FEI]: kept, [MERGED_FEI]: kept });
      // The merged firm keeps its row, behind an alias.
      expect(await aliases()).toEqual({ [merged]: kept });
      expect(await db.select({ id: firm.id }).from(firm).orderBy(asc(firm.id))).toEqual([{ id: kept }, { id: merged }]);
      // The kept firm's facts and alternative names now count the merged firm's records.
      expect(await firmView(kept)).toMatchObject({
        altNames: ['FUJIAN DONGWEI FOOD CO.,LTD', 'FUJIAN DONGWEI FOODS'],
        metrics: {
          fda_refusals_total: 2,
          au_failed_total: 1,
          import_alert_red_current: 1,
          import_alert_green_current: 0,
        },
      });

      // A later refusal under the merged firm's FEI goes to the kept firm, which holds that FEI now.
      const later = await insertRefusal(db, {
        fei: MERGED_FEI,
        firmName: 'FUJIAN DONGWEI FOODS',
        countryCode: 'CN',
        refusalDate: '2026-09-01',
      });
      expect(await linkEntities(db, { today: TODAY })).toMatchObject({ firmsCreated: 0, linked: 1, feisAssigned: 0 });
      expect((await recordFirms())[`fda_refusal/${later.key}`]).toBe(kept);
    });

    it('merge re-points every reference to the merged firm', async () => {
      const kept = await insertFirm(db, { displayName: 'Busan Marine Products', countryCode: 'KR' });
      const merged = await insertFirm(db, { displayName: 'Busan Marine Product Co.', countryCode: 'KR' });
      const other = await insertFirm(db, { displayName: 'Hanil Seafood', countryCode: 'KR' });
      // A firm merged into the merged firm before; it is the newer of those two.
      const mergedBefore = await insertFirm(db, { displayName: 'Busan Marine', countryCode: 'KR' });
      await db.insert(firmAlias).values({ oldId: mergedBefore, newId: merged });
      await db.insert(firmFei).values({ fei: MERGED_FEI, firmId: merged });
      const refusal = await insertRefusal(db, { fei: MERGED_FEI, countryCode: 'KR', firmId: merged }, { notice: true });
      await insertListing(db, { countryCode: 'KR', firmId: merged });
      await insertAuRow(db, { countryCode: 'KR', firmId: merged });
      const event = await insertEvent(db, { source: 'fda_refusal', sourceKey: refusal.key, firmId: merged });
      await db.insert(matchReview).values([
        { source: 'fda_refusal', sourceKey: refusal.key, firmId: merged, candidateFirmId: other, score: '0.8100' },
        { source: 'fda_refusal', sourceKey: 'fda-elsewhere', firmId: other, candidateFirmId: merged, score: '0.7800' },
      ]);
      const orgId = await insertOrg();
      await watch(orgId, merged);
      await db.insert(lookupLog).values({ orgId, firmId: merged, period: '2026-10' });
      await insertAlert(orgId, event, merged);
      const jobId = randomUUID();
      await db.insert(bulkJob).values({ id: jobId, orgId, fileName: 'suppliers.csv', total: 1 });
      await db.insert(bulkJobRow).values({ jobId, rowNr: 1, inputName: 'Busan Marine', firmId: merged });
      await insertDispute(orgId, merged);
      // The fixture fills every foreign key on firm.
      expect(Object.keys(await referencesTo(merged)).sort()).toEqual([
        'alert.firm_id',
        'au_failing_food.firm_id',
        'bulk_job_row.firm_id',
        'change_event.firm_id',
        'dispute.firm_id',
        'fda_refusal.firm_id',
        'firm_alias.new_id',
        'firm_fei.firm_id',
        'import_alert_listing.firm_id',
        'lookup_log.firm_id',
        'match_review.candidate_firm_id',
        'match_review.firm_id',
        'notice.firm_id',
        'watchlist_item.firm_id',
      ]);

      const { moved } = await merge([kept, merged]);

      expect(await referencesTo(merged)).toEqual({});
      expect(moved).toEqual({
        fda_refusal: 1,
        import_alert_listing: 1,
        au_failing_food: 1,
        notice: 1,
        change_event: 1,
        alert: 1,
        bulk_job_row: 1,
        dispute: 1,
        firm_fei: 1,
        match_review: 2,
        watchlist_item: 1,
        lookup_log: 1,
        firm_alias: 2,
      });
      expect(await aliases()).toEqual({ [mergedBefore]: kept, [merged]: kept });
    });

    it('watchlists follow a merged firm, one item per account', async () => {
      const kept = await insertFirm(db, { displayName: 'Gurudev Spices' });
      const merged = await insertFirm(db, { displayName: 'Gurudev Spice Mills' });
      const [watchesBoth, watchesBothAtOnce, watchesMerged, watchesKept] = [
        await insertOrg(),
        await insertOrg(),
        await insertOrg(),
        await insertOrg(),
      ];
      // The account's older item is the one on the merged firm: it stays, with its label, and the other goes.
      const olderItem = await watch(watchesBoth, merged, {
        label: 'Our turmeric supplier',
        createdAt: new Date('2026-01-05T10:00:00Z'),
      });
      await watch(watchesBoth, kept, { createdAt: new Date('2026-03-01T10:00:00Z') });
      // Added at the same moment: the smaller id stays.
      const sameMoment = new Date('2026-02-01T08:00:00Z');
      const smallerId = await watch(watchesBothAtOnce, kept, {
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: sameMoment,
      });
      await watch(watchesBothAtOnce, merged, { id: '00000000-0000-4000-8000-000000000002', createdAt: sameMoment });
      const onMerged = await watch(watchesMerged, merged);
      const onKept = await watch(watchesKept, kept);
      const topic = randomUUID();
      await db
        .insert(watchlistItem)
        .values({ id: topic, orgId: watchesBoth, kind: 'topic', topicKey: 'IN:spices', originCountry: 'IN' });

      const { moved } = await merge([kept, merged]);

      expect(moved).toEqual({ watchlist_item: 2, watchlist_item_deleted: 2, firm_alias: 1 });
      const items = await db
        .select({ id: watchlistItem.id, orgId: watchlistItem.orgId, firmId: watchlistItem.firmId })
        .from(watchlistItem);
      expect(Object.fromEntries(items.map(({ id, ...item }) => [id, item]))).toEqual({
        [olderItem]: { orgId: watchesBoth, firmId: kept },
        [smallerId]: { orgId: watchesBothAtOnce, firmId: kept },
        [onMerged]: { orgId: watchesMerged, firmId: kept },
        [onKept]: { orgId: watchesKept, firmId: kept },
        [topic]: { orgId: watchesBoth, firmId: null },
      });
      const [{ label }] = await db
        .select({ label: watchlistItem.label })
        .from(watchlistItem)
        .where(eq(watchlistItem.id, olderItem));
      expect(label).toBe('Our turmeric supplier');
    });

    it('lookup logs merge without a key clash', async () => {
      const kept = await insertFirm(db);
      const merged = await insertFirm(db);
      const a = await insertOrg('00000000-0000-4000-8000-00000000000a');
      const b = await insertOrg('00000000-0000-4000-8000-00000000000b');
      await db.insert(lookupLog).values([
        // Account a opened both firms in September, the merged one first...
        { orgId: a, firmId: kept, period: '2026-09', firstAt: new Date('2026-09-20T10:00:00Z') },
        { orgId: a, firmId: merged, period: '2026-09', firstAt: new Date('2026-09-03T08:00:00Z') },
        // ...and both in October, the kept one first.
        { orgId: a, firmId: kept, period: '2026-10', firstAt: new Date('2026-10-01T09:00:00Z') },
        { orgId: a, firmId: merged, period: '2026-10', firstAt: new Date('2026-10-15T12:00:00Z') },
        // Account b opened only the kept firm in September and only the merged one in October.
        { orgId: b, firmId: kept, period: '2026-09', firstAt: new Date('2026-09-11T07:00:00Z') },
        { orgId: b, firmId: merged, period: '2026-10', firstAt: new Date('2026-10-05T07:00:00Z') },
      ]);

      const { moved } = await merge([kept, merged]);

      expect(moved).toEqual({ lookup_log: 3, firm_alias: 1 });
      expect(await db.select().from(lookupLog).orderBy(asc(lookupLog.orgId), asc(lookupLog.period))).toEqual([
        { orgId: a, firmId: kept, period: '2026-09', firstAt: new Date('2026-09-03T08:00:00Z') },
        { orgId: a, firmId: kept, period: '2026-10', firstAt: new Date('2026-10-01T09:00:00Z') },
        { orgId: b, firmId: kept, period: '2026-09', firstAt: new Date('2026-09-11T07:00:00Z') },
        { orgId: b, firmId: kept, period: '2026-10', firstAt: new Date('2026-10-05T07:00:00Z') },
      ]);
    });

    it('aliases stay one hop', async () => {
      // Oldest first, so that each merge keeps the second firm: A into B, then B into C.
      const c = await insertFirm(db, { displayName: 'Firm C' });
      const b = await insertFirm(db, { displayName: 'Firm B' });
      const a = await insertFirm(db, { displayName: 'Firm A' });

      await merge([a, b]);
      const { moved } = await merge([b, c]);

      expect(moved).toEqual({ firm_alias: 2 });
      expect(await aliases()).toEqual({ [a]: c, [b]: c });
    });

    it('merge resolves the review between the two firms', async () => {
      const kept = await insertFirm(db);
      const merged = await insertFirm(db);
      const other = await insertFirm(db);
      const ids = await db
        .insert(matchReview)
        .values([
          review(merged, kept),
          // A reviewer kept the two apart; the merge overrules that.
          review(kept, merged, {
            status: 'kept_separate',
            decidedBy: EARLIER_ACTOR,
            decidedAt: new Date('2026-05-01T00:00:00Z'),
          }),
          review(merged, other),
          review(other, kept),
        ])
        .returning({ id: matchReview.id });
      const {
        rows: [{ before }],
      } = await db.execute<{ before: string }>(sql`select now()::text as before`);

      await merge([kept, merged]);

      const reviews = await db
        .select({
          id: matchReview.id,
          firmId: matchReview.firmId,
          candidateFirmId: matchReview.candidateFirmId,
          status: matchReview.status,
          decidedBy: matchReview.decidedBy,
          decidedAt: matchReview.decidedAt,
        })
        .from(matchReview)
        .orderBy(asc(matchReview.id));
      const linked = { firmId: kept, candidateFirmId: kept, status: 'linked', decidedBy: ACTOR };
      expect(reviews).toEqual([
        { id: ids[0].id, ...linked, decidedAt: expect.any(Date) },
        { id: ids[1].id, ...linked, decidedAt: expect.any(Date) },
        // The kept firm takes the merged firm's other reviews, still open.
        { id: ids[2].id, firmId: kept, candidateFirmId: other, status: 'open', decidedBy: null, decidedAt: null },
        { id: ids[3].id, firmId: other, candidateFirmId: kept, status: 'open', decidedBy: null, decidedAt: null },
      ]);
      // Both were decided by the merge, not before it, and its audit row names them.
      const { rows } = await db.execute<{ decided: number }>(
        sql`select count(*)::int as decided from match_review where decided_at >= ${before}::timestamptz`,
      );
      expect(rows).toEqual([{ decided: 2 }]);
      expect(await auditRows()).toMatchObject([{ details: { reviewsDecided: [ids[0].id, ids[1].id] } }]);
    });

    it('merge decides only the reviews between the two firms, and earlier decisions stand', async () => {
      // A and then B are merged into K.
      const k = await insertFirm(db);
      const a = await insertFirm(db);
      const b = await insertFirm(db);
      const [aWithK, aWithB, kWithB] = (
        await db
          .insert(matchReview)
          .values([review(a, k), review(a, b), review(k, b)])
          .returning({ id: matchReview.id })
      ).map(({ id }) => id);
      const secondActor = randomUUID();

      await mergeFirms(db, { firmIds: [k, a], actorUserId: ACTOR, today: TODAY });
      const firstDecision = await decisionOf(aWithK);
      await mergeFirms(db, { firmIds: [k, b], actorUserId: secondActor, today: TODAY });

      // The first merge decided A's review of K, and the second leaves that decision as it was.
      expect(firstDecision).toMatchObject({ status: 'linked', decidedBy: ACTOR, decidedAt: expect.any(String) });
      expect(await decisionOf(aWithK)).toEqual(firstDecision);
      // The second decided the reviews between K and B: K's own, and A's review of B, which the first merge moved to K.
      expect(await decisionOf(aWithB)).toMatchObject({ status: 'linked', decidedBy: secondActor });
      expect(await decisionOf(kWithB)).toMatchObject({ status: 'linked', decidedBy: secondActor });
      expect(await auditRows()).toMatchObject([
        { details: { mergedId: a, reviewsDecided: [aWithK] } },
        { details: { mergedId: b, reviewsDecided: [aWithB, kWithB] } },
      ]);
    });

    it('merge refuses one firm twice, a missing firm and a merged-away firm, and writes nothing', async () => {
      const kept = await insertFirm(db);
      const mergedAway = await insertFirm(db);
      const other = await insertFirm(db);
      await db.insert(firmAlias).values({ oldId: mergedAway, newId: kept });
      await insertRefusal(db, { firmId: other });

      await expect(merge([other, other])).rejects.toThrow(`Firm ${other} cannot be merged with itself`);
      await expect(merge([other, other + 1])).rejects.toThrow(`Firm ${other + 1} does not exist`);
      await expect(merge([kept - 1, other])).rejects.toThrow(`Firm ${kept - 1} does not exist`);
      // Merged away, as the newer firm and as the older one.
      await expect(merge([kept, mergedAway])).rejects.toThrow(`Firm ${mergedAway} was merged into firm ${kept}`);
      await expect(merge([other, mergedAway])).rejects.toThrow(`Firm ${mergedAway} was merged into firm ${kept}`);

      expect(await aliases()).toEqual({ [mergedAway]: kept });
      expect(Object.values(await recordFirms())).toEqual([other]);
      expect(await auditRows()).toEqual([]);
    });
  });

  describe('splitFirm', () => {
    /**
     * Golden Harvest Foods in Thailand: three refusals under two FEIs, a third FEI without refusals, a listing and an
     * Australian test, each with its notice; events on two refusals and the listing, alerts on two of those events,
     * disputes about a refusal, the Australian test and the firm itself, and reviews of two refusals and the listing.
     * The refusals' and the listing's keys are fixed, so that their order is known: by key, the listing comes first.
     */
    async function insertGoldenHarvest() {
      const firmId = await insertFirm(db, { displayName: 'Golden Harvest Foods Co., Ltd.', countryCode: 'TH' });
      // The firm the reviews compare Golden Harvest with.
      const candidate = await insertFirm(db, { displayName: 'Golden Harvest Food Products', countryCode: 'TH' });
      await db.insert(firmFei).values([
        { fei: SPLIT_FEI, firmId },
        { fei: STAYING_FEI, firmId },
        { fei: IDLE_FEI, firmId },
      ]);
      const th = { countryCode: 'TH', firmId };
      const refusals = [
        await insertRefusal(
          db,
          {
            ...th,
            sourceKey: 'fda-b',
            fei: SPLIT_FEI,
            firmName: 'GOLDEN HARVEST FOODS CO., LTD.',
            addressLine1: '12 Old Road',
            city: 'NONTHABURI',
            refusalDate: '2025-11-20',
          },
          { notice: true },
        ),
        await insertRefusal(
          db,
          {
            ...th,
            sourceKey: 'fda-a',
            fei: SPLIT_FEI,
            firmName: 'GOLDEN HARVEST FOOD CO LTD',
            addressLine1: '88 Rama II Rd',
            city: 'BANGKOK',
            region: 'Bangkok',
            postalCode: '10150',
            refusalDate: '2026-06-05',
          },
          { notice: true },
        ),
        await insertRefusal(
          db,
          {
            ...th,
            sourceKey: 'fda-c',
            fei: STAYING_FEI,
            firmName: 'GOLDEN HARVEST FOODS CO., LTD.',
            refusalDate: '2026-03-01',
          },
          { notice: true },
        ),
      ];
      const listing = await insertListing(
        db,
        {
          ...th,
          listingKey: 'aa-listing',
          firmName: 'Golden Harvest Foods',
          city: 'SAMUT SAKHON',
          listedOn: '2024-01-15',
        },
        { notice: true },
      );
      const auRow = await insertAuRow(
        db,
        { ...th, producerName: 'Golden Harvest Foods Company', reportMonth: '2026-02-01', failedOn: '2026-02-03' },
        { notice: true },
      );
      const events = [
        await insertEvent(db, { source: 'fda_refusal', sourceKey: refusals[0].key, firmId }),
        await insertEvent(db, { source: 'import_alert', sourceKey: listing.key, firmId }),
        await insertEvent(db, { source: 'fda_refusal', sourceKey: refusals[2].key, firmId }),
      ];
      const orgId = await insertOrg();
      const alerts = [await insertAlert(orgId, events[0], firmId), await insertAlert(orgId, events[2], firmId)];
      const disputes = [
        await insertDispute(orgId, firmId, ref('fda_refusal', refusals[0])),
        await insertDispute(orgId, firmId, ref('au_ifis', auRow)),
        await insertDispute(orgId, firmId),
      ];
      const reviews = (
        await db
          .insert(matchReview)
          .values([
            { ...review(firmId, candidate), sourceKey: refusals[0].key },
            // Linked when an earlier merge brought the listing's firm into this one, which left it pointing at itself.
            {
              ...review(firmId, firmId, {
                status: 'linked',
                decidedBy: EARLIER_ACTOR,
                decidedAt: new Date('2026-05-01T00:00:00Z'),
              }),
              source: 'import_alert',
              sourceKey: listing.key,
            },
            { ...review(firmId, candidate), sourceKey: refusals[2].key },
          ])
          .returning({ id: matchReview.id })
      ).map(({ id }) => id);
      return { firmId, candidate, refusals, listing, auRow, events, alerts, disputes, reviews };
    }

    /** Each review's firm, candidate and decision, by id. */
    async function reviewsById() {
      const rows = await db
        .select({
          id: matchReview.id,
          firmId: matchReview.firmId,
          candidateFirmId: matchReview.candidateFirmId,
          status: matchReview.status,
          decidedBy: matchReview.decidedBy,
        })
        .from(matchReview);
      return Object.fromEntries(rows.map(({ id, ...row }) => [id, row]));
    }

    it('split moves records, their notices and events, and FEIs whose refusals all moved', async () => {
      const { firmId, candidate, refusals, listing, auRow, events, alerts, disputes, reviews } =
        await insertGoldenHarvest();
      const {
        rows: [{ before }],
      } = await db.execute<{ before: string }>(sql`select now()::text as before`);

      const result = await splitFirm(db, {
        firmId,
        records: [ref('import_alert', listing), ref('fda_refusal', refusals[1]), ref('fda_refusal', refusals[0])],
        actorUserId: ACTOR,
        today: TODAY,
      });

      const { newFirmId } = result;
      expect(result).toEqual({
        fromId: firmId,
        newFirmId: expect.any(Number),
        moved: {
          fda_refusal: 2,
          import_alert_listing: 1,
          notice: 3,
          change_event: 2,
          alert: 1,
          dispute: 1,
          match_review: 2,
          firm_fei: 1,
        },
      });
      expect(newFirmId).not.toBe(firmId);
      const records = {
        [`fda_refusal/${refusals[0].key}`]: newFirmId,
        [`fda_refusal/${refusals[1].key}`]: newFirmId,
        [`fda_refusal/${refusals[2].key}`]: firmId,
        [`import_alert/${listing.key}`]: newFirmId,
        [`au_ifis/${auRow.key}`]: firmId,
      };
      expect(await recordFirms()).toEqual(records);
      expect(await noticeFirms()).toEqual(records);
      expect(await eventFirms()).toEqual({ [events[0]]: newFirmId, [events[1]]: newFirmId, [events[2]]: firmId });
      expect(firmsById(await db.select({ id: alert.id, firmId: alert.firmId }).from(alert))).toEqual({
        [alerts[0]]: newFirmId,
        [alerts[1]]: firmId,
      });
      expect(firmsById(await db.select({ id: dispute.id, firmId: dispute.firmId }).from(dispute))).toEqual({
        [disputes[0]]: newFirmId,
        [disputes[1]]: firmId,
        [disputes[2]]: firmId,
      });
      // A moved record's review goes with it. The listing's was linked; the split reverses that.
      expect(await reviewsById()).toEqual({
        [reviews[0]]: { firmId: newFirmId, candidateFirmId: candidate, status: 'open', decidedBy: null },
        [reviews[1]]: { firmId: newFirmId, candidateFirmId: firmId, status: 'kept_separate', decidedBy: ACTOR },
        [reviews[2]]: { firmId, candidateFirmId: candidate, status: 'open', decidedBy: null },
      });
      const { rows: decided } = await db.execute<{ bySplit: boolean }>(
        sql`select decided_at >= ${before}::timestamptz as "bySplit" from match_review where id = ${reviews[1]}`,
      );
      expect(decided).toEqual([{ bySplit: true }]);
      // Only the FEI whose refusals all moved goes; an FEI without refusals stays.
      expect(await feiFirms()).toEqual({ [SPLIT_FEI]: newFirmId, [STAYING_FEI]: firmId, [IDLE_FEI]: firmId });
      // The new firm is named and placed as its latest record, the refusal of 2026-06-05 (P3-D6). Both firms' facts and
      // alternative names are refreshed.
      expect(await firmView(newFirmId)).toEqual({
        displayName: 'GOLDEN HARVEST FOOD CO LTD',
        nameNorm: 'golden harvest food',
        countryCode: 'TH',
        region: 'bangkok',
        city: 'bangkok',
        postalCode: '10150',
        addressNorm: '88 rama ii road',
        firstSeen: '2024-01-15',
        altNames: ['GOLDEN HARVEST FOODS CO., LTD.', 'Golden Harvest Foods'],
        metrics: {
          fda_refusals_total: 2,
          au_failed_total: 0,
          import_alert_red_current: 1,
          import_alert_green_current: 0,
        },
      });
      expect(await firmView(firmId)).toEqual({
        displayName: 'Golden Harvest Foods Co., Ltd.',
        nameNorm: 'golden harvest foods',
        countryCode: 'TH',
        region: null,
        city: null,
        postalCode: null,
        addressNorm: null,
        firstSeen: '2026-02-03',
        altNames: ['Golden Harvest Foods Company'],
        metrics: {
          fda_refusals_total: 1,
          au_failed_total: 1,
          import_alert_red_current: 0,
          import_alert_green_current: 0,
        },
      });
    });

    it('split refuses to divide an FEI or to move every record', async () => {
      const { firmId, candidate, refusals, listing, auRow } = await insertGoldenHarvest();
      const split = (records: RecordRef[]) => splitFirm(db, { firmId, records, actorUserId: ACTOR, today: TODAY });
      const before = await recordFirms();
      const reviewsBefore = await reviewsById();

      // Only one of the two refusals under SPLIT_FEI.
      await expect(split([ref('fda_refusal', refusals[0]), ref('import_alert', listing)])).rejects.toThrow(
        `FEI ${SPLIT_FEI} has refusals on both sides of the split`,
      );
      await expect(
        split([
          ...refusals.map((refusal) => ref('fda_refusal', refusal)),
          ref('import_alert', listing),
          ref('au_ifis', auRow),
        ]),
      ).rejects.toThrow(`A split must leave firm ${firmId} at least one record`);

      expect(await recordFirms()).toEqual(before);
      expect(await reviewsById()).toEqual(reviewsBefore);
      expect(await db.select({ id: firm.id }).from(firm).orderBy(asc(firm.id))).toEqual([
        { id: firmId },
        { id: candidate },
      ]);
      expect(await auditRows()).toEqual([]);
    });

    it('split refuses records of other firms, and an empty selection', async () => {
      const { firmId, candidate: other, refusals } = await insertGoldenHarvest();
      const elsewhere = await insertRefusal(db, { countryCode: 'TH', firmId: other });
      const unlinked = await insertRefusal(db, { countryCode: 'TH' });
      const split = (records: RecordRef[]) => splitFirm(db, { firmId, records, actorUserId: ACTOR, today: TODAY });
      const before = await recordFirms();

      for (const record of [
        ref('fda_refusal', elsewhere),
        ref('fda_refusal', unlinked),
        // The key of one of the firm's refusals, under another source.
        ref('au_ifis', refusals[0]),
      ]) {
        await expect(split([ref('fda_refusal', refusals[2]), record])).rejects.toThrow(
          `${record.source} ${record.key} is not a record of firm ${firmId}`,
        );
      }
      await expect(split([])).rejects.toThrow('A split needs at least one record');

      expect(await recordFirms()).toEqual(before);
      expect(await db.select({ id: firm.id }).from(firm).orderBy(asc(firm.id))).toEqual([
        { id: firmId },
        { id: other },
      ]);
      expect(await auditRows()).toEqual([]);
    });

    it('a split leaves no orphan records', async () => {
      const { firmId, refusals, listing } = await insertGoldenHarvest();

      await splitFirm(db, {
        firmId,
        records: [ref('fda_refusal', refusals[0]), ref('fda_refusal', refusals[1]), ref('import_alert', listing)],
        actorUserId: ACTOR,
        today: TODAY,
      });

      // Every record still has a firm, and every row that follows a record (or an event, for an alert) has its firm. A
      // linked review points a firm at itself.
      const { rows } = await db.execute(sql`
        with records (source, source_key, fei, firm_id) as (
          select 'fda_refusal', source_key, fei, firm_id from fda_refusal
          union all
          select 'import_alert', listing_key, null::bigint, firm_id from import_alert_listing
          union all
          select 'au_ifis', source_key, null::bigint, firm_id from au_failing_food
        )
        select
          (select count(*)::int from records where firm_id is null) as unlinked_records,
          (select count(*)::int from notice join records using (source, source_key)
           where notice.firm_id is distinct from records.firm_id) as notices,
          (select count(*)::int from change_event join records using (source, source_key)
           where change_event.firm_id is distinct from records.firm_id) as events,
          (select count(*)::int from alert join change_event on change_event.id = alert.change_event_id
           where alert.firm_id is distinct from change_event.firm_id) as alerts,
          (select count(*)::int from dispute join records using (source, source_key)
           where dispute.firm_id is distinct from records.firm_id) as disputes,
          (select count(*)::int from match_review join records using (source, source_key)
           where match_review.firm_id is distinct from records.firm_id) as reviews,
          (select count(*)::int from match_review
           where status = 'linked' and firm_id <> candidate_firm_id) as linked_apart,
          (select count(*)::int from firm_fei join records using (fei)
           where firm_fei.firm_id is distinct from records.firm_id) as feis`);
      expect(rows).toEqual([
        {
          unlinked_records: 0,
          notices: 0,
          events: 0,
          alerts: 0,
          disputes: 0,
          reviews: 0,
          linked_apart: 0,
          feis: 0,
        },
      ]);
    });

    it('split audits the records it moved, once each, by source and then key', async () => {
      const { firmId, refusals, listing } = await insertGoldenHarvest();

      const { newFirmId, moved } = await splitFirm(db, {
        firmId,
        // Out of order, and one of them twice.
        records: [
          ref('import_alert', listing),
          ref('fda_refusal', refusals[0]),
          ref('fda_refusal', refusals[1]),
          ref('fda_refusal', refusals[0]),
        ],
        actorUserId: ACTOR,
        today: TODAY,
      });

      expect(await auditRows()).toEqual([
        {
          actorUserId: ACTOR,
          action: 'firm.split',
          targetType: 'firm',
          targetId: String(firmId),
          details: {
            newFirmId,
            moved,
            records: [
              { source: 'fda_refusal', key: 'fda-a' },
              { source: 'fda_refusal', key: 'fda-b' },
              { source: 'import_alert', key: 'aa-listing' },
            ],
          },
        },
      ]);
    });
  });

  it('merge and split write audit_log', async () => {
    const kept = await insertFirm(db);
    const merged = await insertFirm(db);
    await insertRefusal(db, { firmId: kept });
    const refusal = await insertRefusal(db, { firmId: merged });

    await mergeFirms(db, { firmIds: [kept, merged], actorUserId: ACTOR, today: TODAY });
    const { newFirmId } = await splitFirm(db, {
      firmId: kept,
      records: [ref('fda_refusal', refusal)],
      actorUserId: null,
      today: TODAY,
    });

    expect(await auditRows()).toEqual([
      {
        actorUserId: ACTOR,
        action: 'firm.merge',
        targetType: 'firm',
        targetId: String(kept),
        details: { mergedId: merged, moved: { fda_refusal: 1, firm_alias: 1 }, reviewsDecided: [] },
      },
      {
        actorUserId: null,
        action: 'firm.split',
        targetType: 'firm',
        targetId: String(kept),
        details: { newFirmId, moved: { fda_refusal: 1 }, records: [{ source: 'fda_refusal', key: refusal.key }] },
      },
    ]);
  });
});
