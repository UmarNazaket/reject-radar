import { meResponse } from '@rejectradar/contracts';
import { appUser, membership, org } from '@rejectradar/db';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { signUpVerified, startTestApp, type TestApp } from '../testing/test-app';

describe('GET and PATCH /me behind the guards', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp('api_me');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    t.resetRateLimits();
  });

  it('GET /v1/me without cookies answers 401 UNAUTHORIZED', async () => {
    const res = await request(t.app.getHttpServer()).get('/v1/me').expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('GET /v1/me with a garbage access cookie answers 401 INVALID_SESSION', async () => {
    const res = await request(t.app.getHttpServer()).get('/v1/me').set('Cookie', 'rr_at=not-a-jwt').expect(401);
    expect(res.body).toMatchObject({ code: 'INVALID_SESSION' });
  });

  it('GET /v1/me with a verified session returns the user, org and role', async () => {
    const { session, userId, orgId } = await signUpVerified(t, {
      email: 'me.get@example.com',
      name: 'Ayesha Khan',
      company: 'Zarfeen Rice Mills',
    });
    const res = await session.get('/v1/me').expect(200);
    expect(meResponse.parse(res.body)).toEqual({
      user: { id: userId, email: 'me.get@example.com', name: 'Ayesha Khan', locale: 'en', emailVerified: true, isPlatformAdmin: false },
      org: { id: orgId, name: 'Zarfeen Rice Mills' },
      role: 'owner',
    });
  });

  it('PATCH /v1/me without the CSRF header answers 403 CSRF_MISSING', async () => {
    const { session } = await signUpVerified(t, { email: 'me.csrf@example.com' });
    const res = await request(t.app.getHttpServer())
      .patch('/v1/me')
      .set('Cookie', `rr_at=${session.cookie('rr_at')}`)
      .send({ name: 'No Header' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'CSRF_MISSING', message: 'Missing X-RejectRadar-CSRF header.' });
  });

  it('PATCH /v1/me changes name and locale', async () => {
    const { session, userId } = await signUpVerified(t, { email: 'me.patch@example.com' });
    const bengali = await session.patch('/v1/me').send({ locale: 'bn' }).expect(200);
    expect(meResponse.parse(bengali.body).user.locale).toBe('bn');

    const renamed = await session.patch('/v1/me').send({ name: 'Ayesha Rahman' }).expect(200);
    expect(meResponse.parse(renamed.body).user).toMatchObject({ name: 'Ayesha Rahman', locale: 'bn' });
    const [row] = await t.db.select({ name: appUser.name, locale: appUser.locale }).from(appUser).where(eq(appUser.id, userId));
    expect(row).toEqual({ name: 'Ayesha Rahman', locale: 'bn' });

    await session.patch('/v1/me').send({ locale: 'fr' }).expect(400);
    await session.patch('/v1/me').send({}).expect(400);
    const [unchanged] = await t.db.select({ locale: appUser.locale }).from(appUser).where(eq(appUser.id, userId));
    expect(unchanged.locale).toBe('bn');
  });

  it('GET and PATCH /v1/me report the session account when the user also belongs to another', async () => {
    const { session, userId, orgId } = await signUpVerified(t, { email: 'me.twoorgs@example.com', company: 'First Mills' });
    // P4-D1 (one account per user) is app code only; the schema would allow this row.
    const otherOrgId = '0197a3f0-0000-7000-8000-000000000001';
    await t.db.insert(org).values({ id: otherOrgId, name: 'Other Mills' });
    await t.db.insert(membership).values({ orgId: otherOrgId, userId, role: 'member' });
    // Rewriting the session's row moves it after the other one in the table, so an unscoped lookup would find the other first.
    await t.db.update(membership).set({ role: 'owner' }).where(and(eq(membership.orgId, orgId), eq(membership.userId, userId)));

    for (let i = 0; i < 5; i++) {
      const res = await session.get('/v1/me').expect(200);
      expect(meResponse.parse(res.body)).toMatchObject({ org: { id: orgId, name: 'First Mills' }, role: 'owner' });
    }
    const patched = await session.patch('/v1/me').send({ name: 'Two Orgs' }).expect(200);
    expect(meResponse.parse(patched.body)).toMatchObject({ org: { id: orgId }, role: 'owner' });
  });

  it('the old access cookie is refused right after logout', async () => {
    const { session } = await signUpVerified(t, { email: 'me.logout@example.com' });
    const oldAccess = session.cookie('rr_at');
    expect(oldAccess).toBeDefined();
    await session.get('/v1/me').expect(200);
    await session.post('/v1/auth/logout').expect(204);
    const res = await request(t.app.getHttpServer()).get('/v1/me').set('Cookie', `rr_at=${oldAccess}`).expect(401);
    expect(res.body).toMatchObject({ code: 'INVALID_SESSION' });
  });

  it('a deactivated org is refused', async () => {
    const { session, orgId } = await signUpVerified(t, { email: 'me.deactivated@example.com' });
    await session.get('/v1/me').expect(200);
    await t.db.update(org).set({ deactivatedAt: new Date() }).where(eq(org.id, orgId));
    const res = await session.get('/v1/me').expect(403);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
  });

  it('health stays public', async () => {
    await request(t.app.getHttpServer()).get('/v1/health').expect(200);
    await request(t.app.getHttpServer()).get('/v1/health/ready').expect(200);
  });

  it('an unknown route stays 404, not 401', async () => {
    await request(t.app.getHttpServer()).get('/v1/does-not-exist').expect(404);
  });

  it('public auth routes still need the CSRF header on unsafe methods', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: 'someone@example.com', password: 'zarfeen-rice-2026' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'CSRF_MISSING' });
  });
});
