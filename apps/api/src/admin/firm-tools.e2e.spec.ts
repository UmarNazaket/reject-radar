import type { AdminFirmResponse, FirmChangeResponse, MatchReviewItem, MatchReviewsResponse } from '@rejectradar/contracts';
import { appUser, auditLog, firmAlias, matchReview } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('admin match review and firm tools', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let admin: TestSession;
  let adminId: string;
  let user: TestSession;

  beforeAll(async () => {
    t = await startTestApp('api_admin_firm_tools');
    fx = await seedReferenceData(t.db);
    const staff = await signUpVerified(t, { email: 'staff@firm-tools.test' });
    await t.db.update(appUser).set({ isPlatformAdmin: true }).where(eq(appUser.id, staff.userId));
    ({ session: admin, userId: adminId } = staff);
    ({ session: user } = await signUpVerified(t, { email: 'customer@firm-tools.test' }));
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => t.resetRateLimits());

  const addReview = async (firmId: number, candidateFirmId: number, sourceKey: string): Promise<number> => {
    const [{ id }] = await t.db
      .insert(matchReview)
      .values({ source: 'fda_refusal', sourceKey, firmId, candidateFirmId, score: '0.8100', evidence: { name: 0.9 } })
      .returning({ id: matchReview.id });
    return id;
  };

  it('is for platform admins only', async () => {
    const routes = [
      ['get', '/v1/admin/match-reviews'],
      ['post', '/v1/admin/match-reviews/1/decision'],
      ['get', '/v1/admin/firms/1'],
      ['post', '/v1/admin/firms/merge'],
      ['post', '/v1/admin/firms/1/split'],
    ] as const;
    for (const [method, path] of routes) {
      await t.session()[method](path).expect(401);
      expect((await user[method](path).expect(403)).body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('keeps two firms apart, and audits it', async () => {
    const id = await addReview(fx.firms.alRahmanLahore, fx.firms.alRahmanKarachi, 'keep-apart');
    const { items } = (await admin.get('/v1/admin/match-reviews').expect(200)).body as MatchReviewsResponse;
    expect(items.find((item) => item.id === id)).toMatchObject({
      status: 'open',
      score: 0.81,
      firm: { id: fx.firms.alRahmanLahore, city: 'lahore', records: 0, mergedInto: null },
      candidate: { id: fx.firms.alRahmanKarachi, city: 'karachi' },
    });

    const decided = (await admin.post(`/v1/admin/match-reviews/${id}/decision`).send({ same: false }).expect(200)).body as MatchReviewItem;
    expect(decided).toMatchObject({ id, status: 'kept_separate' });
    expect(decided.decidedAt).not.toBeNull();
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'match.keep_separate'));
    expect(audit).toMatchObject({ actorUserId: adminId, targetType: 'match_review', targetId: String(id) });

    const kept = (await admin.get('/v1/admin/match-reviews').query({ status: 'kept_separate' }).expect(200)).body as MatchReviewsResponse;
    expect(kept.items.map((item) => item.id)).toContain(id);
    // A decided review cannot be decided again.
    expect((await admin.post(`/v1/admin/match-reviews/${id}/decision`).send({ same: true }).expect(409)).body).toMatchObject({ code: 'CONFLICT' });
  });

  it('merges the same firm, which links the review', async () => {
    const id = await addReview(fx.firms.alRahmanKarachi, fx.firms.alRahmanLahore, 'same-firm');
    const decided = (await admin.post(`/v1/admin/match-reviews/${id}/decision`).send({ same: true }).expect(200)).body as MatchReviewItem;
    // The merge keeps the older firm, the smaller id, so both sides of the review now name it.
    expect(decided).toMatchObject({ status: 'linked', firm: { id: fx.firms.alRahmanLahore }, candidate: { id: fx.firms.alRahmanLahore } });
    const [alias] = await t.db.select().from(firmAlias).where(eq(firmAlias.oldId, fx.firms.alRahmanKarachi));
    expect(alias.newId).toBe(fx.firms.alRahmanLahore);

    const { firm } = (await admin.get(`/v1/admin/firms/${fx.firms.alRahmanKarachi}`).expect(200)).body as AdminFirmResponse;
    expect(firm.mergedInto).toBe(fx.firms.alRahmanLahore);
    // A firm merged away cannot be merged again.
    const again = await admin.post('/v1/admin/firms/merge').send({ firmIds: [fx.firms.alRahmanKarachi, fx.firms.zarfeen] }).expect(409);
    expect(again.body.message).toBe(`Firm ${fx.firms.alRahmanKarachi} was merged into firm ${fx.firms.alRahmanLahore}`);
  });

  it('splits only the chosen records to a new firm', async () => {
    const before = (await admin.get(`/v1/admin/firms/${fx.firms.zarfeen}`).expect(200)).body as AdminFirmResponse;
    expect(before.firm).toMatchObject({ records: 5, feis: ['3001234567'] });
    expect(before.records.map((r) => r.source).sort()).toEqual(['au_ifis', 'fda_refusal', 'fda_refusal', 'fda_refusal', 'import_alert']);
    const refusal = before.records.find((r) => r.source === 'fda_refusal');
    // One refusal alone would leave its FEI on both sides; every record would leave the firm empty.
    await admin.post(`/v1/admin/firms/${fx.firms.zarfeen}/split`).send({ records: [refusal] }).expect(409);
    await admin
      .post(`/v1/admin/firms/${fx.firms.zarfeen}/split`)
      .send({ records: before.records.map(({ source, key }) => ({ source, key })) })
      .expect(409);

    const moving = before.records.filter((r) => r.source !== 'fda_refusal').map(({ source, key }) => ({ source, key }));
    const split = (await admin.post(`/v1/admin/firms/${fx.firms.zarfeen}/split`).send({ records: moving }).expect(200)).body as FirmChangeResponse;
    expect(split).toMatchObject({ keptId: fx.firms.zarfeen, moved: { import_alert_listing: 1, au_failing_food: 1 } });

    const after = (await admin.get(`/v1/admin/firms/${fx.firms.zarfeen}`).expect(200)).body as AdminFirmResponse;
    expect(after.records.map((r) => r.source)).toEqual(['fda_refusal', 'fda_refusal', 'fda_refusal']);
    const created = (await admin.get(`/v1/admin/firms/${split.otherId}`).expect(200)).body as AdminFirmResponse;
    expect(created.records.map(({ source, key }) => ({ source, key })).sort((a, b) => a.source.localeCompare(b.source))).toEqual(moving.sort((a, b) => a.source.localeCompare(b.source)));
  });

  it('answers 404 for a review or firm that is not there, and 400 for a bad body', async () => {
    await admin.post('/v1/admin/match-reviews/999999/decision').send({ same: true }).expect(404);
    await admin.get('/v1/admin/firms/999999').expect(404);
    await admin.get('/v1/admin/firms/abc').expect(404);
    await admin.post('/v1/admin/firms/merge').send({ firmIds: [1] }).expect(400);
    await admin.post('/v1/admin/firms/merge').send({ firmIds: [fx.firms.zarfeen, fx.firms.zarfeen] }).expect(409);
    await admin.get('/v1/admin/match-reviews').query({ status: 'maybe' }).expect(400);
  });
});
