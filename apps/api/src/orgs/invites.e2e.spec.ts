import { invitePreviewResponse, inviteResponse, meResponse } from '@rejectradar/contracts';
import { translate } from '@rejectradar/i18n';
import { sql } from 'drizzle-orm';
import { sha256Hex } from '../common/tokens';
import { joinByInvite, signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

const PASSWORD = 'basmati-export-77';
const WRONG = 'not-the-password-1';
const DAY_MS = 86_400_000;

describe('invites', () => {
  let t: TestApp;
  let owner: { session: TestSession; userId: string; orgId: string };

  beforeAll(async () => {
    t = await startTestApp('api_invites');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    t.mail.sent.length = 0;
    await t.db.execute(sql`truncate app_user, org, email_delivery cascade`);
    owner = await signUpVerified(t, { email: 'owner@example.com', name: 'Ayesha Khan', company: 'Zarfeen Rice Mills', locale: 'ur' });
    t.mail.sent.length = 0;
  });

  const invite = (email: string, role = 'member', who: TestSession = owner.session) => who.post('/v1/org/invites').send({ email, role });
  const tokenFor = (email: string) => t.mail.linkIn(t.mail.lastTo(email)).pathname.split('/').pop() as string;
  const preview = (token: string) => t.session().post('/v1/invites/preview').send({ token });
  const accept = (body: Record<string, unknown>, session = t.session()) => session.post('/v1/invites/accept').send(body);
  const inviteRows = async () => {
    const result = await t.db.execute<{ id: string; email: string; token_hash: string; accepted_at: string | null; secs: number }>(
      sql`select id, email, token_hash, accepted_at, extract(epoch from expires_at - now())::float as secs from invite order by created_at`,
    );
    return result.rows;
  };
  const userRow = async (email: string) => {
    const result = await t.db.execute<{ locale: string; verified: boolean; failed_logins: number; locked: boolean; name: string }>(
      sql`select locale, name, email_verified_at is not null as verified, failed_logins, coalesce(locked_until > now(), false) as locked
          from app_user where lower(email) = ${email}`,
    );
    return result.rows[0];
  };
  const membershipsOf = async (email: string) => {
    const result = await t.db.execute<{ org_id: string; role: string }>(
      sql`select m.org_id, m.role from membership m join app_user u on u.id = m.user_id where lower(u.email) = ${email}`,
    );
    return result.rows;
  };

  it('an unverified owner cannot invite', async () => {
    const session = t.session();
    await session
      .post('/v1/auth/signup')
      .send({ name: 'Unverified', email: 'unverified@example.com', password: PASSWORD, companyName: 'Unverified Foods', locale: 'en' })
      .expect(202);
    await session.post('/v1/auth/login').send({ email: 'unverified@example.com', password: PASSWORD }).expect(200);

    const res = await invite('someone@example.com', 'member', session).expect(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(await inviteRows()).toHaveLength(0);
  });

  it("invites in the inviter's language", async () => {
    const res = await invite(' New.Person@Example.com ', 'member').expect(201);
    const body = inviteResponse.parse(res.body);
    expect(body).toMatchObject({ email: 'new.person@example.com', role: 'member' });
    const ahead = Date.parse(body.expiresAt) - Date.now();
    expect(ahead).toBeGreaterThan(7 * DAY_MS - 60_000);
    expect(ahead).toBeLessThanOrEqual(7 * DAY_MS + 1000);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);

    expect(t.mail.sent).toHaveLength(1);
    const message = t.mail.lastTo('new.person@example.com');
    expect(message.subject).toBe(translate('ur', 'email.invite.subject', { inviterName: 'Ayesha Khan', orgName: 'Zarfeen Rice Mills' }));
    expect(message.subject).toContain('Ayesha Khan');
    expect(message.subject).toContain('Zarfeen Rice Mills');
    expect(message.text).toContain(translate('ur', 'role.member'));
    expect(message.html).toContain('dir="rtl"');
    expect(t.mail.linkIn(message).href).toMatch(/^http:\/\/localhost:4200\/invite\/[A-Za-z0-9_-]{43}$/);

    const [row] = await inviteRows();
    expect(row.token_hash).toBe(sha256Hex(tokenFor('new.person@example.com')));
    expect(row.token_hash).not.toContain(tokenFor('new.person@example.com'));
    expect(row.secs).toBeGreaterThan(7 * 86_400 - 60);
  });

  it('refuses owner as an invite role', async () => {
    const res = await invite('boss@example.com', 'owner').expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    await invite('not-an-email', 'member').expect(400);
    expect(await inviteRows()).toHaveLength(0);
  });

  it('a member cannot invite', async () => {
    const member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    const res = await invite('another@example.com', 'member', member.session).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('refuses an existing member', async () => {
    await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    const res = await invite(' Member@Example.com ', 'admin').expect(409);
    expect(res.body.code).toBe('ALREADY_MEMBER');
    await invite('owner@example.com', 'admin').expect(409);
  });

  it('re-inviting replaces the pending invite', async () => {
    await invite('new.person@example.com', 'member').expect(201);
    const first = tokenFor('new.person@example.com');
    await invite('NEW.PERSON@example.com', 'admin').expect(201);
    const second = tokenFor('new.person@example.com');
    expect(second).not.toBe(first);

    const stale = await preview(first).expect(400);
    expect(stale.body.code).toBe('INVALID_TOKEN');
    const fresh = await preview(second).expect(200);
    expect(fresh.body.role).toBe('admin');
    expect(await inviteRows()).toHaveLength(1);
  });

  it('parallel invites for one email leave one pending invite', async () => {
    const results = await Promise.all([invite('new.person@example.com', 'member'), invite('new.person@example.com', 'admin')]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await inviteRows()).toHaveLength(1);
  });

  it('limits invites to 20 per hour per user', async () => {
    for (let i = 0; i < 20; i++) await invite(`person${i}@example.com`).expect(201);
    const res = await invite('person20@example.com').expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });

  it('preview shows the account and whether the email has an account', async () => {
    await invite('new.person@example.com', 'member').expect(201);
    const res = await preview(tokenFor('new.person@example.com')).expect(200);
    expect(invitePreviewResponse.parse(res.body)).toEqual({
      orgName: 'Zarfeen Rice Mills',
      email: 'new.person@example.com',
      role: 'member',
      existingUser: false,
    });
    expect(res.headers['set-cookie']).toBeUndefined();

    const other = await signUpVerified(t, { email: 'someone@example.com' });
    await invite('someone@example.com', 'admin').expect(201);
    const known = await preview(tokenFor('someone@example.com')).expect(200);
    expect(known.body).toMatchObject({ email: 'someone@example.com', existingUser: true });
    expect(other.userId).toBeDefined();
  });

  it('preview refuses an unknown or malformed token without saying why', async () => {
    const unknown = await preview('x'.repeat(43)).expect(400);
    expect(unknown.body).toMatchObject({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired.' });
    await t.session().post('/v1/invites/preview').send({}).expect(400);
  });

  it('accepting as a new person creates a verified member and logs in', async () => {
    await invite('new.person@example.com', 'member').expect(201);
    const token = tokenFor('new.person@example.com');
    const session = t.session();

    const res = await accept({ token, name: 'New Person', password: PASSWORD, locale: 'bn' }, session).expect(200);
    const me = meResponse.parse(res.body);
    expect(me.role).toBe('member');
    expect(me.user).toMatchObject({ email: 'new.person@example.com', name: 'New Person', locale: 'bn', emailVerified: true });
    expect(me.org).toEqual({ id: owner.orgId, name: 'Zarfeen Rice Mills' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);
    expect(session.cookie('rr_at')).toBeDefined();
    expect(session.cookie('rr_rt')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await session.get('/v1/me').expect(200)).body.role).toBe('member');

    const [row] = await inviteRows();
    expect(row.accepted_at).not.toBeNull();
    expect(await userRow('new.person@example.com')).toMatchObject({ verified: true, locale: 'bn' });
    expect(await membershipsOf('new.person@example.com')).toEqual([{ org_id: owner.orgId, role: 'member' }]);
    await t.session().post('/v1/auth/login').send({ email: 'new.person@example.com', password: PASSWORD }).expect(200);

    const again = await accept({ token, name: 'New Person', password: PASSWORD }).expect(400);
    expect(again.body.code).toBe('INVALID_TOKEN');
    const gone = await preview(token).expect(400);
    expect(gone.body.code).toBe('INVALID_TOKEN');
  });

  it("a new person's language defaults to the inviter's", async () => {
    await invite('new.person@example.com', 'admin').expect(201);
    const res = await accept({ token: tokenFor('new.person@example.com'), name: 'New Person', password: PASSWORD }).expect(200);
    expect(res.body.user.locale).toBe('ur');
    expect(res.body.role).toBe('admin');
  });

  it('a new person must give a name', async () => {
    await invite('new.person@example.com', 'member').expect(201);
    const token = tokenFor('new.person@example.com');
    const res = await accept({ token, password: PASSWORD }).expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(await userRow('new.person@example.com')).toBeUndefined();
    // Nothing was spent: the same link still works with a name.
    await accept({ token, name: 'New Person', password: PASSWORD }).expect(200);
  });

  it('a new person cannot choose a common password', async () => {
    await invite('new.person@example.com', 'member').expect(201);
    const token = tokenFor('new.person@example.com');
    const res = await accept({ token, name: 'New Person', password: 'qwertyuiop' }).expect(400);
    expect(res.body.code).toBe('COMMON_PASSWORD');
    expect(await userRow('new.person@example.com')).toBeUndefined();
    await accept({ token, name: 'New Person', password: PASSWORD }).expect(200);
  });

  it('accepting as an existing user without an account needs their password', async () => {
    const member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    await owner.session.delete(`/v1/org/members/${member.userId}`).expect(204);
    await invite('member@example.com', 'admin').expect(201);
    const token = tokenFor('member@example.com');
    expect((await preview(token).expect(200)).body.existingUser).toBe(true);

    const wrong = await accept({ token, password: WRONG }).expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect((await userRow('member@example.com')).failed_logins).toBe(1);
    expect(await membershipsOf('member@example.com')).toEqual([]);

    const session = t.session();
    const res = await accept({ token, password: PASSWORD }, session).expect(200);
    expect(res.body).toMatchObject({ role: 'admin', user: { id: member.userId, email: 'member@example.com' }, org: { id: owner.orgId } });
    expect(await membershipsOf('member@example.com')).toEqual([{ org_id: owner.orgId, role: 'admin' }]);
    expect((await userRow('member@example.com')).failed_logins).toBe(0);
    await session.get('/v1/me').expect(200);
  });

  it('an unverified existing user who accepts is verified by the link', async () => {
    const member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    await owner.session.delete(`/v1/org/members/${member.userId}`).expect(204);
    await t.db.execute(sql`update app_user set email_verified_at = null where id = ${member.userId}`);
    await invite('member@example.com', 'member').expect(201);

    const res = await accept({ token: tokenFor('member@example.com'), password: PASSWORD }).expect(200);
    expect(res.body).toMatchObject({ user: { id: member.userId, emailVerified: true }, org: { id: owner.orgId } });
    expect((await userRow('member@example.com')).verified).toBe(true);
  });

  it('an unverified member accepting an invite to their own account is verified by the link', async () => {
    const member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    await t.db.execute(sql`update app_user set email_verified_at = null where id = ${member.userId}`);
    await t.db.execute(sql`
      insert into invite (id, org_id, email, role, token_hash, invited_by, expires_at)
      values (gen_random_uuid(), ${owner.orgId}, 'member@example.com', 'admin', ${sha256Hex('v'.repeat(43))}, ${owner.userId}, now() + interval '1 day')`);

    const res = await accept({ token: 'v'.repeat(43), password: PASSWORD }).expect(200);
    expect(res.body).toMatchObject({ role: 'member', user: { id: member.userId, emailVerified: true } });
    expect((await userRow('member@example.com')).verified).toBe(true);
  });

  it('wrong passwords on accept count toward the lockout', async () => {
    const member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    await owner.session.delete(`/v1/org/members/${member.userId}`).expect(204);
    await invite('member@example.com', 'member').expect(201);
    const token = tokenFor('member@example.com');

    for (let i = 0; i < 5; i++) await accept({ token, password: WRONG }).expect(401);
    expect((await userRow('member@example.com')).locked).toBe(true);
    const locked = await accept({ token, password: PASSWORD }).expect(401);
    expect(locked.body.code).toBe('INVALID_CREDENTIALS');
    expect(await membershipsOf('member@example.com')).toEqual([]);
  });

  it('accepting while in another account is refused', async () => {
    const other = await signUpVerified(t, { email: 'someone@example.com', company: 'Other Foods' });
    await invite('someone@example.com', 'member').expect(201);
    const token = tokenFor('someone@example.com');

    const wrong = await accept({ token, password: WRONG }).expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    const res = await accept({ token, password: 'zarfeen-rice-2026' }).expect(409);
    expect(res.body.code).toBe('ALREADY_IN_ACCOUNT');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await membershipsOf('someone@example.com')).toEqual([{ org_id: other.orgId, role: 'owner' }]);
    // The refusal does not spend the invite.
    expect((await inviteRows())[0].accepted_at).toBeNull();
  });

  it('accept and preview never answer ALREADY_MEMBER', async () => {
    const member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    await invite('member@example.com', 'admin').expect(409);
    // An invite created before the person joined, accepted by a person who is by now a member of that account.
    await t.db.execute(sql`
      insert into invite (id, org_id, email, role, token_hash, invited_by, expires_at)
      values (gen_random_uuid(), ${owner.orgId}, 'member@example.com', 'admin', ${sha256Hex('m'.repeat(43))}, ${owner.userId}, now() + interval '1 day')`);
    const wrong = await accept({ token: 'm'.repeat(43), password: WRONG }).expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    const session = t.session();
    const res = await accept({ token: 'm'.repeat(43), password: PASSWORD }, session).expect(200);
    expect(res.body).toMatchObject({ role: 'member', user: { id: member.userId }, org: { id: owner.orgId } });
    await session.get('/v1/me').expect(200);
  });

  it('accepting an invite to the account you are already in is idempotent and keeps your role', async () => {
    const member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    await t.db.execute(sql`
      insert into invite (id, org_id, email, role, token_hash, invited_by, expires_at)
      values (gen_random_uuid(), ${owner.orgId}, 'member@example.com', 'admin', ${sha256Hex('m'.repeat(43))}, ${owner.userId}, now() + interval '1 day')`);

    const session = t.session();
    const res = await accept({ token: 'm'.repeat(43), password: PASSWORD }, session).expect(200);
    expect(meResponse.parse(res.body)).toMatchObject({ role: 'member', user: { id: member.userId }, org: { id: owner.orgId } });
    expect(session.cookie('rr_at')).toBeDefined();
    expect(await membershipsOf('member@example.com')).toEqual([{ org_id: owner.orgId, role: 'member' }]);
    const rows = await inviteRows();
    expect(rows.filter((r) => r.accepted_at !== null).map((r) => r.id)).toHaveLength(2);

    const again = await accept({ token: 'm'.repeat(43), password: PASSWORD }).expect(400);
    expect(again.body.code).toBe('INVALID_TOKEN');
  });

  it('the same person accepting two invites at once joins one account', async () => {
    const other = await signUpVerified(t, { email: 'other@example.com', company: 'Other Foods' });
    const person = await joinByInvite(t, owner.session, { email: 'person@example.com', role: 'member' });
    await owner.session.delete(`/v1/org/members/${person.userId}`).expect(204);
    await invite('person@example.com', 'member').expect(201);
    const first = tokenFor('person@example.com');
    await invite('person@example.com', 'member', other.session).expect(201);
    const second = tokenFor('person@example.com');

    const results = await Promise.all([accept({ token: first, password: PASSWORD }), accept({ token: second, password: PASSWORD })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('ALREADY_IN_ACCOUNT');
    expect(await membershipsOf('person@example.com')).toHaveLength(1);
  });

  it('one invite accepted twice at once is used once', async () => {
    await invite('new.person@example.com', 'member').expect(201);
    const token = tokenFor('new.person@example.com');
    const results = await Promise.all([
      accept({ token, name: 'New Person', password: PASSWORD }),
      accept({ token, name: 'New Person', password: PASSWORD }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400)?.body.code).toBe('INVALID_TOKEN');
    expect(await membershipsOf('new.person@example.com')).toHaveLength(1);
  });

  it('an invite expires after 7 days', async () => {
    await invite('new.person@example.com', 'member').expect(201);
    const token = tokenFor('new.person@example.com');
    await t.db.execute(sql`update invite set expires_at = now() + interval '1 hour'`);
    await preview(token).expect(200);

    await t.db.execute(sql`update invite set expires_at = now() - interval '1 second'`);
    expect((await preview(token).expect(400)).body.code).toBe('INVALID_TOKEN');
    const res = await accept({ token, name: 'New Person', password: PASSWORD }).expect(400);
    expect(res.body.code).toBe('INVALID_TOKEN');
    expect(await userRow('new.person@example.com')).toBeUndefined();
  });

  it('revoking an invite', async () => {
    const created = await invite('new.person@example.com', 'member').expect(201);
    const token = tokenFor('new.person@example.com');

    const member = await joinByInvite(t, owner.session, { email: 'member@example.com', role: 'member' });
    const denied = await member.session.delete(`/v1/org/invites/${created.body.id}`).expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');

    await owner.session.delete(`/v1/org/invites/${created.body.id}`).expect(204);
    expect((await preview(token).expect(400)).body.code).toBe('INVALID_TOKEN');
    await owner.session.delete(`/v1/org/invites/${created.body.id}`).expect(404);
  });

  it("another account's invite cannot be revoked", async () => {
    const created = await invite('new.person@example.com', 'member').expect(201);
    const stranger = await signUpVerified(t, { email: 'stranger@example.com' });
    const res = await stranger.session.delete(`/v1/org/invites/${created.body.id}`).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
    await stranger.session.delete('/v1/org/invites/not-an-id').expect(404);
    expect(await inviteRows()).toHaveLength(1);
  });
});
