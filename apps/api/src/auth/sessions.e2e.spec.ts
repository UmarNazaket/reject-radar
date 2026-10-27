import { Logger } from '@nestjs/common';
import { meResponse } from '@rejectradar/contracts';
import { sql } from 'drizzle-orm';
import type { Response } from 'supertest';
import { sha256Hex } from '../common/tokens';
import { startTestApp, type TestApp, type TestSession } from '../testing/test-app';
import { AccessTokenService } from './access-tokens';

const EMAIL = 'ayesha.khan@example.com';
const PASSWORD = 'zarfeen-rice-2026';
const WRONG = 'not-the-password-1';
const CREDENTIALS_MESSAGE = 'Email or password is incorrect. After 5 failed attempts, sign-in is paused for 15 minutes.';

interface ParsedCookie {
  value: string;
  attributes: Map<string, string>;
}

describe('sessions: login, lockout, refresh rotation and logout', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp('api_sessions');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    t.mail.sent.length = 0;
    await t.db.execute(sql`truncate app_user, org, email_delivery cascade`);
  });

  const signUp = async (email = EMAIL) => {
    await t
      .session()
      .post('/v1/auth/signup')
      .send({ name: 'Ayesha Khan', email, password: PASSWORD, companyName: 'Zarfeen Rice Mills', locale: 'en' })
      .expect(202);
  };
  const login = (session: TestSession, body: { email?: string; password?: string } = {}) =>
    session.post('/v1/auth/login').send({ email: EMAIL, password: PASSWORD, ...body });
  const loggedIn = async () => {
    await signUp();
    const session = t.session();
    await login(session).expect(200);
    return session;
  };

  /** Parses the Set-Cookie line for `name`; undefined when the response did not set it. */
  const setCookie = (res: Response, name: string): ParsedCookie | undefined => {
    const lines = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const line = lines.find((l) => l.startsWith(`${name}=`));
    if (!line) return undefined;
    const [pair, ...rest] = line.split(';').map((part) => part.trim());
    const attributes = new Map(
      rest.map((attribute): [string, string] => {
        const [key, ...value] = attribute.split('=');
        return [key.toLowerCase(), value.join('=')];
      }),
    );
    return { value: pair.slice(name.length + 1), attributes };
  };
  const expectCleared = (res: Response) => {
    const access = setCookie(res, 'rr_at');
    const refresh = setCookie(res, 'rr_rt');
    expect(access?.value).toBe('');
    expect(access?.attributes.get('max-age')).toBe('0');
    expect(access?.attributes.get('path')).toBe('/');
    expect(refresh?.value).toBe('');
    expect(refresh?.attributes.get('max-age')).toBe('0');
    expect(refresh?.attributes.get('path')).toBe('/v1/auth');
    for (const cookie of [access, refresh]) {
      expect(cookie?.attributes.has('httponly')).toBe(true);
      expect(cookie?.attributes.has('domain')).toBe(false);
    }
  };

  const tokenRows = async () => {
    const result = await t.db.execute<{
      id: string;
      family_id: string;
      token_hash: string;
      revoked_at: string | null;
      replaced_by: string | null;
    }>(sql`select id, family_id, token_hash, revoked_at, replaced_by from refresh_token order by created_at, id`);
    return result.rows;
  };
  const userRow = async () =>
    (
      await t.db.execute<{ failed_logins: number; locked_until: string | null; secs: number | null }>(
        sql`select failed_logins, locked_until, extract(epoch from locked_until - now())::float as secs from app_user`,
      )
    ).rows[0];

  it('logs in an unverified user and sets both cookies', async () => {
    await signUp();
    const session = t.session();
    const res = await login(session, { email: ' AYESHA.KHAN@example.com ' }).expect(200);

    const me = meResponse.parse(res.body);
    expect(me.user).toMatchObject({ email: EMAIL, name: 'Ayesha Khan', locale: 'en', emailVerified: false, isPlatformAdmin: false });
    expect(me.org.name).toBe('Zarfeen Rice Mills');
    expect(me.role).toBe('owner');
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);

    const access = setCookie(res, 'rr_at');
    expect(access?.attributes.has('httponly')).toBe(true);
    expect(access?.attributes.has('secure')).toBe(true);
    expect(access?.attributes.get('samesite')).toBe('Lax');
    expect(access?.attributes.get('path')).toBe('/');
    expect(access?.attributes.get('max-age')).toBe('900');
    expect(access?.attributes.has('domain')).toBe(false);

    const refresh = setCookie(res, 'rr_rt');
    expect(refresh?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refresh?.attributes.has('httponly')).toBe(true);
    expect(refresh?.attributes.has('secure')).toBe(true);
    expect(refresh?.attributes.get('samesite')).toBe('Lax');
    expect(refresh?.attributes.get('path')).toBe('/v1/auth');
    expect(refresh?.attributes.get('max-age')).toBe('2592000');
    expect(refresh?.attributes.has('domain')).toBe(false);

    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(sha256Hex(refresh?.value as string));
    expect(JSON.stringify(rows[0])).not.toContain(refresh?.value as string);
    expect(t.app.get(AccessTokenService).verify(access?.value as string)).toEqual({
      userId: me.user.id,
      orgId: me.org.id,
      familyId: rows[0].family_id,
    });
  });

  it('answers the same for a wrong password and an unknown email', async () => {
    await signUp();
    const wrong = await login(t.session(), { password: WRONG }).expect(401);
    const unknown = await login(t.session(), { email: 'nobody@example.com' }).expect(401);
    expect({ code: wrong.body.code, message: wrong.body.message }).toEqual({ code: 'INVALID_CREDENTIALS', message: CREDENTIALS_MESSAGE });
    expect({ code: unknown.body.code, message: unknown.body.message }).toEqual({ code: wrong.body.code, message: wrong.body.message });
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(unknown.headers['set-cookie']).toBeUndefined();
    expect(await tokenRows()).toHaveLength(0);
  });

  it('locks after 5 failures for 15 minutes', async () => {
    await signUp();
    for (let i = 1; i <= 4; i++) {
      await login(t.session(), { password: WRONG }).expect(401);
      expect((await userRow()).failed_logins).toBe(i);
    }
    await login(t.session(), { password: WRONG }).expect(401);
    expect((await userRow()).failed_logins).toBe(0);

    const locked = await login(t.session()).expect(401);
    expect(locked.body).toMatchObject({ code: 'INVALID_CREDENTIALS', message: CREDENTIALS_MESSAGE });
    const { secs } = await userRow();
    expect(secs).toBeGreaterThan(14 * 60);
    expect(secs).toBeLessThanOrEqual(15 * 60);
    expect(await tokenRows()).toHaveLength(0);

    await t.db.execute(sql`update app_user set locked_until = now() - interval '1 second'`);
    await login(t.session()).expect(200);
    expect(await userRow()).toMatchObject({ failed_logins: 0, locked_until: null });
  });

  it('counts parallel failures atomically', async () => {
    await signUp();
    const results = await Promise.all(Array.from({ length: 5 }, () => login(t.session(), { password: WRONG })));
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    const row = await userRow();
    expect(row.failed_logins).toBe(0);
    expect(row.locked_until).not.toBeNull();
  });

  it('resets the failure count after a successful login', async () => {
    await signUp();
    await login(t.session(), { password: WRONG }).expect(401);
    await login(t.session(), { password: WRONG }).expect(401);
    await login(t.session()).expect(200);
    expect((await userRow()).failed_logins).toBe(0);
  });

  it('limits login to 10 per 15 minutes per IP and email', async () => {
    for (let i = 0; i < 10; i++) await login(t.session(), { email: 'nobody@example.com' }).expect(401);
    const limited = await login(t.session(), { email: ' Nobody@Example.com' }).expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    await login(t.session(), { email: 'someone-else@example.com' }).expect(401);
  });

  it('rotates the refresh token', async () => {
    const session = await loggedIn();
    const first = session.cookie('rr_rt') as string;

    const res = await session.post('/v1/auth/refresh').expect(204);
    expect(res.body).toEqual({});
    const refresh = setCookie(res, 'rr_rt');
    const access = setCookie(res, 'rr_at');
    expect(refresh?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refresh?.value).not.toBe(first);
    expect(refresh?.attributes.get('path')).toBe('/v1/auth');
    expect(refresh?.attributes.get('max-age')).toBe('2592000');
    expect(access?.value).toBeDefined();
    expect(access?.attributes.get('max-age')).toBe('900');
    expect(session.cookie('rr_rt')).toBe(refresh?.value);

    const [oldRow, newRow] = await tokenRows();
    expect(oldRow.token_hash).toBe(sha256Hex(first));
    expect(oldRow.revoked_at).not.toBeNull();
    expect(oldRow.replaced_by).toBe(newRow.id);
    expect(newRow.token_hash).toBe(sha256Hex(refresh?.value as string));
    expect(newRow.family_id).toBe(oldRow.family_id);
    expect(newRow.revoked_at).toBeNull();

    const claims = t.app.get(AccessTokenService).verify(access?.value as string);
    expect(claims?.familyId).toBe(oldRow.family_id);
    await session.post('/v1/auth/refresh').expect(204);
  });

  it('refuses a refresh without a cookie, or with an unknown one, and clears the cookies', async () => {
    const none = await t.session().post('/v1/auth/refresh').expect(401);
    expect(none.body.code).toBe('INVALID_SESSION');
    expectCleared(none);
    const unknown = await t.session().post('/v1/auth/refresh').set('Cookie', 'rr_rt=unknown-token-value').expect(401);
    expect(unknown.body.code).toBe('INVALID_SESSION');
    expectCleared(unknown);
  });

  it('revokes the family when a used token comes back after 10 seconds', async () => {
    const session = await loggedIn();
    const old = session.cookie('rr_rt') as string;
    await session.post('/v1/auth/refresh').expect(204);
    const newest = session.cookie('rr_rt') as string;
    await t.db.execute(sql`update refresh_token set revoked_at = now() - interval '11 seconds' where token_hash = ${sha256Hex(old)}`);

    const warn = jest.spyOn(Logger.prototype, 'warn');
    const replay = await t.session().post('/v1/auth/refresh').set('Cookie', `rr_rt=${old}`).expect(401);
    expect(replay.body).toMatchObject({ code: 'INVALID_SESSION' });
    expectCleared(replay);
    const [first] = await tokenRows();
    expect(warn).toHaveBeenCalledWith({ userId: expect.any(String), familyId: first.family_id }, 'Refresh token reuse');
    warn.mockRestore();

    const rows = await tokenRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
    const again = await t.session().post('/v1/auth/refresh').set('Cookie', `rr_rt=${newest}`).expect(401);
    expect(again.body.code).toBe('INVALID_SESSION');
  });

  it('tolerates a race within 10 seconds', async () => {
    const session = await loggedIn();
    const [a, b] = await Promise.all([session.post('/v1/auth/refresh'), session.post('/v1/auth/refresh')]);
    const ok = [a, b].filter((r) => r.status === 204);
    const raced = [a, b].filter((r) => r.status === 401);
    expect(ok).toHaveLength(1);
    expect(raced).toHaveLength(1);
    expect(raced[0].body.code).toBe('REFRESH_RACE');
    expect(raced[0].headers['set-cookie']).toBeUndefined();

    const rows = await tokenRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
    await session.post('/v1/auth/refresh').expect(204);
  });

  it('refuses an expired refresh token', async () => {
    const session = await loggedIn();
    await t.db.execute(sql`update refresh_token set expires_at = now() - interval '1 second'`);
    const res = await session.post('/v1/auth/refresh').expect(401);
    expect(res.body.code).toBe('INVALID_SESSION');
    expectCleared(res);
  });

  it('revokes the session when the membership is gone or the account is deactivated', async () => {
    const session = await loggedIn();
    await t.db.execute(sql`update org set deactivated_at = now()`);
    const res = await session.post('/v1/auth/refresh').expect(401);
    expect(res.body.code).toBe('INVALID_SESSION');
    expectCleared(res);
    expect((await tokenRows()).every((row) => row.revoked_at !== null)).toBe(true);

    await t.db.execute(sql`update org set deactivated_at = null`);
    const second = t.session();
    await login(second).expect(200);
    await t.db.execute(sql`delete from membership`);
    const removed = await second.post('/v1/auth/refresh').expect(401);
    expect(removed.body.code).toBe('INVALID_SESSION');
    expect((await tokenRows()).every((row) => row.revoked_at !== null)).toBe(true);
  });

  it('logout revokes the family and clears cookies', async () => {
    const session = await loggedIn();
    await session.post('/v1/auth/refresh').expect(204);
    const token = session.cookie('rr_rt') as string;

    const res = await session.post('/v1/auth/logout').expect(204);
    expectCleared(res);
    expect(session.cookie('rr_rt')).toBeUndefined();
    expect((await tokenRows()).every((row) => row.revoked_at !== null)).toBe(true);

    const after = await t.session().post('/v1/auth/refresh').set('Cookie', `rr_rt=${token}`).expect(401);
    expect(after.body.code).toBe('INVALID_SESSION');
  });

  it('logout needs no access token and is idempotent', async () => {
    const session = await loggedIn();
    const refreshOnly = t.session();
    const res = await refreshOnly.post('/v1/auth/logout').set('Cookie', `rr_rt=${session.cookie('rr_rt')}`).expect(204);
    expectCleared(res);
    expect((await tokenRows()).every((row) => row.revoked_at !== null)).toBe(true);

    expectCleared(await t.session().post('/v1/auth/logout').expect(204));
    expectCleared(await t.session().post('/v1/auth/logout').set('Cookie', 'rr_rt=never-issued').expect(204));
    expectCleared(await session.post('/v1/auth/logout').expect(204));
  });

  it('refuses login with 403 NO_MEMBERSHIP for a user without a membership', async () => {
    await signUp();
    await t.db.execute(sql`delete from membership`);
    const res = await login(t.session()).expect(403);
    expect(res.body.code).toBe('NO_MEMBERSHIP');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await tokenRows()).toHaveLength(0);
    // Without the password the answer is the same as for any other wrong login.
    const wrong = await login(t.session(), { password: WRONG }).expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses login with 403 ACCOUNT_DEACTIVATED for a deactivated org', async () => {
    await signUp();
    await t.db.execute(sql`update org set deactivated_at = now()`);
    const res = await login(t.session()).expect(403);
    expect(res.body.code).toBe('ACCOUNT_DEACTIVATED');
    expect(res.headers['set-cookie']).toBeUndefined();
    const wrong = await login(t.session(), { password: WRONG }).expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a malformed login body with 400', async () => {
    await t.session().post('/v1/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);
    await t.session().post('/v1/auth/login').send({ email: EMAIL }).expect(400);
  });
});
