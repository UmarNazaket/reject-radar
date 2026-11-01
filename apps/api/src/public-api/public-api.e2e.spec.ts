import { type CreatedApiKeyResponse, type PublicUsageResponse, utcPeriod } from '@rejectradar/contracts';
import { apiKey, org, usageCounter } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('public API', () => {
  let t: TestApp;
  let ref: ReferenceFixture;
  let owner: TestSession;
  let orgId: string;
  let key: CreatedApiKeyResponse;

  beforeAll(async () => {
    t = await startTestApp('api_public_api');
    ref = await seedReferenceData(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    await t.db.execute(sql`truncate app_user, org, email_delivery cascade`);
    ({ session: owner, orgId } = await signUpVerified(t, { email: 'owner@public-api.test' }));
    await setPlan(t, orgId, 'business');
    key = (await owner.post('/v1/org/api-keys').send({ name: 'Integration' }).expect(201)).body as CreatedApiKeyResponse;
  });

  const call = (path: string, bearer: string | null = key.key) => {
    const req = request(t.app.getHttpServer()).get(path);
    return bearer === null ? req : req.set('Authorization', `Bearer ${bearer}`);
  };
  const apiCalls = async () =>
    (await t.db.select({ n: usageCounter.apiCalls }).from(usageCounter).where(eq(usageCounter.orgId, orgId)))[0]?.n ?? 0;

  describe('the key', () => {
    it('is required, as a bearer token with the rr_live_ prefix', async () => {
      expect((await call('/v1/public/taxonomy', null).expect(401)).body).toMatchObject({ code: 'API_KEY_MISSING' });
      expect((await call('/v1/public/taxonomy', 'sk_live_abc').expect(401)).body).toMatchObject({ code: 'API_KEY_MISSING' });
      await request(t.app.getHttpServer()).get('/v1/public/taxonomy').set('Authorization', key.key).expect(401);
    });

    it('must be one the API issued and not revoked', async () => {
      expect((await call('/v1/public/taxonomy', `${key.key}x`).expect(401)).body).toMatchObject({ code: 'API_KEY_INVALID' });
      await owner.delete(`/v1/org/api-keys/${key.id}`).expect(204);
      expect((await call('/v1/public/taxonomy').expect(401)).body).toMatchObject({ code: 'API_KEY_INVALID' });
      expect(await apiCalls()).toBe(0);
    });

    it('stops working after a downgrade, without being deleted', async () => {
      await setPlan(t, orgId, 'pro');
      expect((await call('/v1/public/taxonomy').expect(403)).body).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', details: { feature: 'api', plan: 'pro' } });
      await setPlan(t, orgId, 'business');
      await call('/v1/public/taxonomy').expect(200);
    });

    it('of a deactivated account is refused', async () => {
      await t.db.update(org).set({ deactivatedAt: new Date() }).where(eq(org.id, orgId));
      expect((await call('/v1/public/taxonomy').expect(403)).body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
    });

    it('does not open app routes, and a session does not open public ones', async () => {
      expect((await call('/v1/notices').expect(401)).body).toMatchObject({ code: 'UNAUTHORIZED' });
      expect((await owner.get('/v1/public/notices').expect(401)).body).toMatchObject({ code: 'API_KEY_MISSING' });
    });

    it('records when it was last used, at most once an hour', async () => {
      await call('/v1/public/taxonomy').expect(200);
      const lastUsed = async () => (await t.db.select({ at: apiKey.lastUsedAt }).from(apiKey).where(eq(apiKey.id, key.id)))[0].at;
      expect(await lastUsed()).toBeInstanceOf(Date);

      const halfHourAgo = new Date(Date.now() - 1_800_000);
      await t.db.update(apiKey).set({ lastUsedAt: halfHourAgo }).where(eq(apiKey.id, key.id));
      await call('/v1/public/taxonomy').expect(200);
      expect(await lastUsed()).toEqual(halfHourAgo);

      await t.db.update(apiKey).set({ lastUsedAt: new Date(Date.now() - 7_200_000) }).where(eq(apiKey.id, key.id));
      await call('/v1/public/taxonomy').expect(200);
      expect((await lastUsed())?.getTime()).toBeGreaterThan(halfHourAgo.getTime());
    });
  });

  describe('the routes', () => {
    /** The same request through the app (session) and the public API (key) gives the same body. */
    const same = async (appPath: string, publicPath: string) => {
      const app = (await owner.get(appPath).expect(200)).body as unknown;
      const pub = (await call(publicPath).expect(200)).body as unknown;
      expect(pub).toEqual(app);
    };

    it('serve the app routes with their contracts', async () => {
      await same('/v1/notices?origin=PK', '/v1/public/notices?origin=PK');
      await same(`/v1/notices/${ref.notices.rasff}`, `/v1/public/notices/${ref.notices.rasff}`);
      await same('/v1/dashboards/topic?origin=PK', '/v1/public/dashboards/topic?origin=PK');
      await same('/v1/firms/search?name=Zarfeen%20Rice', '/v1/public/firms/search?name=Zarfeen%20Rice');
      await same('/v1/import-alerts/99-08?locale=ur', '/v1/public/import-alerts/99-08?locale=ur');
      await same('/v1/taxonomy?locale=hi', '/v1/public/taxonomy?locale=hi');
      await same('/v1/mrl/residues?q=tricyc', '/v1/public/mrl/residues?q=tricyc');
      await same('/v1/mrl?commodity=101&residue=1001&lab=0.2', '/v1/public/mrl?commodity=101&residue=1001&lab=0.2');
    });

    it('a firm profile also uses a lookup, as in the app', async () => {
      const res = await call(`/v1/public/firms/${ref.firms.zarfeen}`).expect(200);
      expect(res.body).toMatchObject({ id: ref.firms.zarfeen, lookup: { charged: true, used: 1 } });
      const app = await owner.get(`/v1/firms/${ref.firms.zarfeen}`).expect(200);
      expect(app.body).toMatchObject({ lookup: { charged: false, used: 1 } });
    });

    it('validate their input like the app', async () => {
      expect((await call('/v1/public/firms/search').expect(400)).body).toMatchObject({ code: 'BAD_REQUEST' });
      await call('/v1/public/notices/abc').expect(404);
      await call('/v1/public/import-alerts/xx').expect(400);
      await call('/v1/public/mrl?commodity=101').expect(400);
      await call('/v1/public/mrl?commodity=101&residue=9999').expect(404);
    });
  });

  describe('the quota', () => {
    it('charges one call per request and reports it in headers', async () => {
      const first = await call('/v1/public/taxonomy').expect(200);
      expect(first.headers['x-quota-used']).toBe('1');
      expect(first.headers['x-quota-limit']).toBe('10000');
      await call('/v1/public/notices').expect(200);
      expect(await apiCalls()).toBe(2);
    });

    it('refuses the call after the last one of the month', async () => {
      await t.db.insert(usageCounter).values({ orgId, period: utcPeriod(), apiCalls: 9999 });
      expect((await call('/v1/public/taxonomy').expect(200)).headers['x-quota-used']).toBe('10000');
      const res = await call('/v1/public/taxonomy').expect(403);
      expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { action: 'api_calls', plan: 'business', limit: 10000, used: 10000 } });
      expect(await apiCalls()).toBe(10000);
    });

    it('usage reads the month without being charged', async () => {
      await call('/v1/public/taxonomy').expect(200);
      const usage = (await call('/v1/public/usage').expect(200)).body as PublicUsageResponse;
      expect(usage).toEqual({ period: utcPeriod(), apiCalls: { used: 1, limit: 10000 } });
      expect(await apiCalls()).toBe(1);
    });
  });

  it('allows 60 calls a minute per key; a refused call is not charged', async () => {
    for (let i = 0; i < 60; i++) await call('/v1/public/taxonomy').expect(200);
    const res = await call('/v1/public/taxonomy').expect(429);
    expect(res.headers['retry-after']).toEqual(expect.stringMatching(/^\d+$/));
    expect(await apiCalls()).toBe(60);
    // Another key of the same account has its own window.
    const other = (await owner.post('/v1/org/api-keys').send({ name: 'Second' }).expect(201)).body as CreatedApiKeyResponse;
    await call('/v1/public/taxonomy', other.key).expect(200);
  });
});
