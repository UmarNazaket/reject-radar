import { type ApiKeysResponse, type CreatedApiKeyResponse, MAX_API_KEYS } from '@rejectradar/contracts';
import { apiKey, auditLog } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import { sha256Hex } from '../common/tokens';
import { joinByInvite, setPlan, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('API keys', () => {
  let t: TestApp;
  let owner: TestSession;
  let orgId: string;

  beforeAll(async () => {
    t = await startTestApp('api_api_keys');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    await t.db.execute(sql`truncate app_user, org, email_delivery, audit_log cascade`);
    ({ session: owner, orgId } = await signUpVerified(t, { email: 'owner@keys.test', name: 'Key Owner' }));
    await setPlan(t, orgId, 'business');
  });

  const create = (session: TestSession, name = 'Supplier sync') => session.post('/v1/org/api-keys').send({ name });

  it('creates a key that is shown once and stored only as its hash', async () => {
    const res = await create(owner).expect(201);
    const created = res.body as CreatedApiKeyResponse;
    expect(created.key).toMatch(/^rr_live_[A-Za-z0-9_-]{43}$/);
    expect(created).toMatchObject({ name: 'Supplier sync', prefix: created.key.slice(0, 12), createdByName: 'Key Owner', lastUsedAt: null, revokedAt: null });

    const [row] = await t.db.select().from(apiKey).where(eq(apiKey.id, created.id));
    expect(row.keyHash).toBe(sha256Hex(created.key));
    expect(JSON.stringify(row)).not.toContain(created.key);

    const list = (await owner.get('/v1/org/api-keys').expect(200)).body as ApiKeysResponse;
    expect(list.keys).toEqual([{ id: created.id, name: 'Supplier sync', prefix: created.prefix, createdByName: 'Key Owner', createdAt: created.createdAt, lastUsedAt: null, revokedAt: null }]);
    expect(JSON.stringify(list)).not.toContain(created.key);

    const audit = await t.db.select().from(auditLog).where(eq(auditLog.targetId, created.id));
    expect(audit).toMatchObject([{ action: 'api_key.created', targetType: 'api_key', details: { orgId, prefix: created.prefix } }]);
  });

  it('a plan without the API cannot create keys', async () => {
    for (const plan of ['free', 'pro'] as const) {
      await setPlan(t, orgId, plan);
      const res = await create(owner).expect(403);
      expect(res.body).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', details: { feature: 'api', plan } });
    }
  });

  it('owners and admins manage keys; members may not', async () => {
    const admin = await joinByInvite(t, owner, { email: 'admin@keys.test', role: 'admin' });
    await create(admin.session).expect(201);
    const member = await joinByInvite(t, owner, { email: 'member@keys.test', role: 'member' });
    expect((await create(member.session).expect(403)).body).toMatchObject({ code: 'FORBIDDEN' });
    await member.session.get('/v1/org/api-keys').expect(403);
  });

  it(`holds at most ${MAX_API_KEYS} live keys; a revoked key frees its place`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_API_KEYS; i++) ids.push(((await create(owner, `Key ${i}`).expect(201)).body as CreatedApiKeyResponse).id);
    expect((await create(owner).expect(409)).body).toMatchObject({ code: 'API_KEY_LIMIT' });
    await owner.delete(`/v1/org/api-keys/${ids[0]}`).expect(204);
    await create(owner).expect(201);
  });

  it('two creates of the last place cannot both pass', async () => {
    for (let i = 0; i < MAX_API_KEYS - 1; i++) await create(owner, `Key ${i}`).expect(201);
    const statuses = (await Promise.all([create(owner, 'A'), create(owner, 'B')])).map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('revokes a key once and keeps its row', async () => {
    const { id } = (await create(owner).expect(201)).body as CreatedApiKeyResponse;
    await owner.delete(`/v1/org/api-keys/${id}`).expect(204);
    await owner.delete(`/v1/org/api-keys/${id}`).expect(204);
    const list = (await owner.get('/v1/org/api-keys').expect(200)).body as ApiKeysResponse;
    expect(list.keys[0].revokedAt).toEqual(expect.any(String));
    const audit = await t.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.targetId, id));
    expect(audit.map((row) => row.action).sort()).toEqual(['api_key.created', 'api_key.revoked']);
  });

  it('an unknown key answers 404', async () => {
    await owner.delete('/v1/org/api-keys/0192c7a0-0000-7000-8000-000000000000').expect(404);
    await owner.delete('/v1/org/api-keys/not-a-uuid').expect(404);
  });

  it('a key needs a name', async () => {
    expect((await create(owner, '   ').expect(400)).body).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
