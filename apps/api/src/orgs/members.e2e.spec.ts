import { membersResponse, orgResponse } from '@rejectradar/contracts';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { joinByInvite, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

const PASSWORD = 'basmati-export-77';

interface Person {
  session: TestSession;
  userId: string;
}

describe('account settings and members', () => {
  let t: TestApp;
  let orgId: string;
  let owner: Person; // O
  let owner2: Person; // O2
  let admin: Person; // A
  let member: Person; // M

  beforeAll(async () => {
    t = await startTestApp('api_members');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    t.mail.sent.length = 0;
    await t.db.execute(sql`truncate app_user, org, email_delivery cascade`);

    const first = await signUpVerified(t, { email: 'owner@example.com', name: 'Owner One', company: 'Zarfeen Rice Mills' });
    orgId = first.orgId;
    owner = first;
    admin = await joinByInvite(t, owner.session, { email: 'admin@example.com', role: 'admin', name: 'Admin' });
    member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member', name: 'Member' });
    owner2 = await joinByInvite(t, owner.session, { email: 'owner2@example.com', role: 'admin', name: 'Owner Two' });
    await owner.session.patch(`/v1/org/members/${owner2.userId}`).send({ role: 'owner' }).expect(204);
  });

  const roleOf = async (userId: string) => {
    const result = await t.db.execute<{ role: string }>(sql`select role from membership where user_id = ${userId}`);
    return result.rows[0]?.role;
  };
  const ownerCount = async (id = orgId) => {
    const result = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from membership where org_id = ${id} and role = 'owner'`);
    return result.rows[0].n;
  };
  const patchRole = (who: Person, target: Person, role: string) => who.session.patch(`/v1/org/members/${target.userId}`).send({ role });

  it('M cannot change roles', async () => {
    const res = await patchRole(member, admin, 'member').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(await roleOf(admin.userId)).toBe('admin');
  });

  it('A promotes M to admin and back', async () => {
    await patchRole(admin, member, 'admin').expect(204);
    expect(await roleOf(member.userId)).toBe('admin');
    // The promoted member's next request already carries the new role (P4-D3).
    await patchRole(member, admin, 'admin').expect(204);
    await patchRole(admin, member, 'member').expect(204);
    expect(await roleOf(member.userId)).toBe('member');
  });

  it('A cannot grant owner or demote an owner', async () => {
    const grant = await patchRole(admin, member, 'owner').expect(403);
    expect(grant.body.code).toBe('FORBIDDEN');
    const demote = await patchRole(admin, owner2, 'member').expect(403);
    expect(demote.body.code).toBe('FORBIDDEN');
    const remove = await admin.session.delete(`/v1/org/members/${owner2.userId}`).expect(403);
    expect(remove.body.code).toBe('FORBIDDEN');
    expect(await roleOf(member.userId)).toBe('member');
    expect(await roleOf(owner2.userId)).toBe('owner');
  });

  it('O makes A an owner', async () => {
    await patchRole(owner, admin, 'owner').expect(204);
    expect(await roleOf(admin.userId)).toBe('owner');
    expect(await ownerCount()).toBe(3);
  });

  it('an unknown member, or one from another account, is 404 NOT_FOUND', async () => {
    const stranger = await signUpVerified(t, { email: 'stranger@example.com' });
    const other = await patchRole(owner, stranger, 'member').expect(404);
    expect(other.body.code).toBe('NOT_FOUND');
    expect(await roleOf(stranger.userId)).toBe('owner');
    await owner.session.delete(`/v1/org/members/${stranger.userId}`).expect(404);
    await owner.session.delete('/v1/org/members/not-an-id').expect(404);
    await owner.session.delete('/v1/org/members/018f0000-0000-7000-8000-000000000000').expect(404);
    expect(await ownerCount(stranger.orgId)).toBe(1);
  });

  it('the last owner cannot be demoted or removed', async () => {
    const solo = await signUpVerified(t, { email: 'solo@example.com' });
    const demote = await patchRole(solo, solo, 'admin').expect(409);
    expect(demote.body.code).toBe('LAST_OWNER');
    const remove = await solo.session.delete(`/v1/org/members/${solo.userId}`).expect(409);
    expect(remove.body.code).toBe('LAST_OWNER');
    expect(await ownerCount(solo.orgId)).toBe(1);
  });

  it('two owners demoting each other at once leave one owner', async () => {
    const results = await Promise.all([patchRole(owner, owner2, 'admin'), patchRole(owner2, owner, 'admin')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([204, 409]);
    const failed = results.find((r) => r.status === 409);
    expect(failed?.body.code).toBe('LAST_OWNER');
    expect(await ownerCount()).toBe(1);
  });

  it('two owners removing each other at once leave one owner', async () => {
    const results = await Promise.all([
      owner.session.delete(`/v1/org/members/${owner2.userId}`),
      owner2.session.delete(`/v1/org/members/${owner.userId}`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(await ownerCount()).toBe(1);
  });

  it('a member can leave', async () => {
    await member.session.delete(`/v1/org/members/${member.userId}`).expect(204);
    expect(await roleOf(member.userId)).toBeUndefined();
  });

  it('a member cannot remove another member', async () => {
    const res = await member.session.delete(`/v1/org/members/${admin.userId}`).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(await roleOf(admin.userId)).toBe('admin');
  });

  it("a removed member's cookies stop working at once", async () => {
    await member.session.get('/v1/me').expect(200);
    await owner.session.delete(`/v1/org/members/${member.userId}`).expect(204);

    const me = await member.session.get('/v1/me').expect(401);
    expect(me.body.code).toBe('INVALID_SESSION');
    await member.session.post('/v1/auth/refresh').expect(401);
    const login = await t.session().post('/v1/auth/login').send({ email: 'member@example.com', password: PASSWORD }).expect(403);
    expect(login.body.code).toBe('NO_MEMBERSHIP');
    const stillThere = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from app_user where lower(email) = 'member@example.com'`);
    expect(stillThere.rows[0].n).toBe(1);
  });

  it('a demoted admin loses admin rights on the next request', async () => {
    await patchRole(owner, admin, 'member').expect(204);
    await patchRole(admin, member, 'admin').expect(403);
  });

  it('PATCH /v1/org as M is 403; as A it renames the account', async () => {
    const denied = await member.session.patch('/v1/org').send({ name: 'Hijacked' }).expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');

    const res = await admin.session.patch('/v1/org').send({ name: '  Zarfeen Foods  ' }).expect(200);
    expect(orgResponse.parse(res.body)).toMatchObject({ id: orgId, name: 'Zarfeen Foods' });
    const read = await member.session.get('/v1/org').expect(200);
    expect(orgResponse.parse(read.body)).toMatchObject({ id: orgId, name: 'Zarfeen Foods' });
    await admin.session.patch('/v1/org').send({ name: '   ' }).expect(400);
  });

  it('GET /v1/org needs a session', async () => {
    await request(t.app.getHttpServer()).get('/v1/org').expect(401);
    await request(t.app.getHttpServer()).get('/v1/org/members').expect(401);
  });

  it('GET /v1/org/members lists members and pending invites', async () => {
    await owner.session.post('/v1/org/invites').send({ email: 'pending@example.com', role: 'member' }).expect(201);
    await owner.session.post('/v1/org/invites').send({ email: 'late@example.com', role: 'admin' }).expect(201);
    await t.db.execute(sql`update invite set expires_at = now() - interval '1 second' where email = 'late@example.com'`);
    const stranger = await signUpVerified(t, { email: 'stranger@example.com' });
    await stranger.session.post('/v1/org/invites').send({ email: 'elsewhere@example.com', role: 'member' }).expect(201);

    const res = await member.session.get('/v1/org/members').expect(200);
    const body = membersResponse.parse(res.body);
    expect(body.members.map((m) => [m.email, m.role]).sort()).toEqual([
      ['admin@example.com', 'admin'],
      ['member@example.com', 'member'],
      ['owner2@example.com', 'owner'],
      ['owner@example.com', 'owner'],
    ]);
    expect(body.members.find((m) => m.userId === owner.userId)).toMatchObject({ name: 'Owner One' });
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({ email: 'pending@example.com', role: 'member', invitedBy: owner.userId });
    expect(JSON.stringify(res.body)).not.toMatch(/token|hash|password/i);
  });
});
