import { dispute, fdaRefusal, lookupLog, usageCounter } from '@rejectradar/db';
import { insertRefusal } from '@rejectradar/entities';
import { eq } from 'drizzle-orm';
import { type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { signUpVerified, startTestApp, type TestApp } from '../testing/test-app';

describe('firm disputes', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let n = 0;

  beforeAll(async () => {
    t = await startTestApp('api_disputes');
    fx = await seedReferenceData(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  const account = () => signUpVerified(t, { email: `user${++n}@disputes.test` });
  const valid = { kind: 'wrong_firm', message: 'This is not our mill; ours is in Karachi.' };

  it("creates an open dispute in the caller's account", async () => {
    const a = await account();
    const b = await account();
    const res = await a.session.post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send({ ...valid, message: `  ${valid.message}  ` }).expect(201);
    const { id } = res.body as { id: string };

    const rows = await t.db.select().from(dispute).where(eq(dispute.id, id));
    expect(rows).toEqual([
      expect.objectContaining({
        orgId: a.orgId,
        userId: a.userId,
        firmId: fx.firms.zarfeen,
        status: 'open',
        kind: 'wrong_firm',
        message: valid.message,
        source: null,
        sourceKey: null,
      }),
    ]);

    // Account B has no rows of any kind from A's dispute, and a dispute uses no lookup of A's either.
    expect(await t.db.select().from(dispute).where(eq(dispute.orgId, b.orgId))).toEqual([]);
    expect(await t.db.select().from(lookupLog).where(eq(lookupLog.orgId, b.orgId))).toEqual([]);
    expect(await t.db.select().from(usageCounter).where(eq(usageCounter.orgId, b.orgId))).toEqual([]);
    expect(await t.db.select().from(lookupLog).where(eq(lookupLog.orgId, a.orgId))).toEqual([]);
    expect(await t.db.select().from(usageCounter).where(eq(usageCounter.orgId, a.orgId))).toEqual([]);
  });

  it('names a record of the firm', async () => {
    const a = await account();
    const [refusal] = await t.db.select().from(fdaRefusal).where(eq(fdaRefusal.firmId, fx.firms.zarfeen)).limit(1);
    const res = await a.session
      .post(`/v1/firms/${fx.firms.zarfeen}/disputes`)
      .send({ ...valid, kind: 'wrong_details', source: 'fda_refusal', sourceKey: refusal.sourceKey })
      .expect(201);
    const [row] = await t.db.select().from(dispute).where(eq(dispute.id, (res.body as { id: string }).id));
    expect(row).toMatchObject({ source: 'fda_refusal', sourceKey: refusal.sourceKey, kind: 'wrong_details' });
  });

  it('a merged-away id files the dispute against the survivor', async () => {
    const a = await account();
    const res = await a.session.post(`/v1/firms/${fx.firms.mergedAway}/disputes`).send(valid).expect(201);
    const [row] = await t.db.select().from(dispute).where(eq(dispute.id, (res.body as { id: string }).id));
    expect(row.firmId).toBe(fx.firms.zarfeen);
  });

  it('a record of another firm is refused', async () => {
    const a = await account();
    const other = await insertRefusal(t.db, { firmId: fx.firms.alRahmanLahore, firmName: 'Al Rahman Rice Mills' });
    const res = await a.session
      .post(`/v1/firms/${fx.firms.zarfeen}/disputes`)
      .send({ ...valid, source: 'fda_refusal', sourceKey: other.key })
      .expect(400);
    expect((res.body as { code: string }).code).toBe('INVALID_RECORD');

    // The right key under the wrong source, and a key that does not exist, are refused the same way.
    const [own] = await t.db.select().from(fdaRefusal).where(eq(fdaRefusal.firmId, fx.firms.zarfeen)).limit(1);
    for (const body of [
      { source: 'au_ifis', sourceKey: own.sourceKey },
      { source: 'import_alert', sourceKey: own.sourceKey },
      { source: 'fda_refusal', sourceKey: 'no-such-record' },
    ]) {
      const refused = await a.session.post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send({ ...valid, ...body }).expect(400);
      expect((refused.body as { code: string }).code).toBe('INVALID_RECORD');
    }
    expect(await t.db.select().from(dispute).where(eq(dispute.orgId, a.orgId))).toEqual([]);
  });

  it('validates the body', async () => {
    const a = await account();
    const post = (body: unknown) => a.session.post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send(body as object);
    await post({ ...valid, message: 'too short' }).expect(400);
    await post({ ...valid, message: `   ${'x'.repeat(5)}   ` }).expect(400);
    await post({ ...valid, message: 'x'.repeat(2001) }).expect(400);
    await post({ ...valid, kind: 'unknown' }).expect(400);
    await post({ ...valid, source: 'fda_refusal' }).expect(400);
    await post({ ...valid, sourceKey: 'abc' }).expect(400);
    await post({ ...valid, source: 'rasff', sourceKey: 'abc' }).expect(400);
    await post({ ...valid, source: 'fda_refusal', sourceKey: 'x'.repeat(201) }).expect(400);
    await post({ ...valid, message: 'x'.repeat(2000) }).expect(201);
  });

  it('404 for an unknown firm', async () => {
    const a = await account();
    const res = await a.session.post('/v1/firms/987654321/disputes').send(valid).expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
    await a.session.post('/v1/firms/abc/disputes').send(valid).expect(404);
  });

  it('10 an hour per user', async () => {
    const a = await account();
    for (let i = 0; i < 10; i++) await a.session.post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send(valid).expect(201);
    const limited = await a.session.post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send(valid).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const other = await account();
    await other.session.post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send(valid).expect(201);
  });

  it('needs a verified email', async () => {
    const unverified = t.session();
    await unverified
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: 'unverified@disputes.test', password: 'zarfeen-rice-2026', companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await unverified.post('/v1/auth/login').send({ email: 'unverified@disputes.test', password: 'zarfeen-rice-2026' }).expect(200);
    const res = await unverified.post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send(valid).expect(403);
    expect((res.body as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('needs a session', async () => {
    await t.session().post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send(valid).expect(401);
  });
});
