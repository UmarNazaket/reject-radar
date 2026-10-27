import { translate } from '@rejectradar/i18n';
import { sql } from 'drizzle-orm';
import { signUpVerified, startTestApp, type TestApp } from '../testing/test-app';
import * as passwords from './passwords';

const EMAIL = 'ayesha.khan@example.com';
const OLD_PASSWORD = 'zarfeen-rice-2026';
const NEW_PASSWORD = 'basmati-harvest-2027';

describe('password reset', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp('api_reset');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    t.mail.sent.length = 0;
    await t.db.execute(sql`truncate app_user, org, email_delivery cascade`);
  });

  const forgot = (email: string) => t.session().post('/v1/auth/forgot-password').send({ email });
  const reset = (token: string, password = NEW_PASSWORD) => t.session().post('/v1/auth/reset-password').send({ token, password });
  const login = (password: string, email = EMAIL) => t.session().post('/v1/auth/login').send({ email, password });
  const tokenFrom = (email: string) => t.mail.linkIn(t.mail.lastTo(email)).searchParams.get('token') as string;
  const requestLink = async (email = EMAIL) => {
    await forgot(email).expect(202);
    return tokenFrom(email);
  };
  const userRow = async () => {
    const result = await t.db.execute<{ failed_logins: number; locked_until: string | null; email_verified_at: string | null }>(
      sql`select failed_logins, locked_until, email_verified_at from app_user`,
    );
    return result.rows[0];
  };

  it("sends a reset link in the user's language", async () => {
    await signUpVerified(t, { email: EMAIL, locale: 'hi', name: 'Ayesha Khan' });
    t.mail.sent.length = 0;

    const res = await forgot(' AYESHA.KHAN@example.com ').expect(202);
    expect(res.body).toEqual({ status: 'check_email' });
    expect(t.mail.sent).toHaveLength(1);
    const message = t.mail.lastTo(EMAIL);
    expect(message.subject).toBe(translate('hi', 'email.reset.subject'));
    expect(t.mail.linkIn(message).href).toMatch(/^http:\/\/localhost:4200\/reset\?token=[A-Za-z0-9_-]{43}$/);
  });

  it('answers the same for an unknown email and sends nothing', async () => {
    await signUpVerified(t, { email: EMAIL });
    t.mail.sent.length = 0;

    const known = await forgot(EMAIL).expect(202);
    const sentForKnown = t.mail.sent.length;
    const unknown = await forgot('nobody@example.com').expect(202);
    expect(unknown.body).toEqual(known.body);
    expect(unknown.body).toEqual({ status: 'check_email' });
    expect(sentForKnown).toBe(1);
    expect(t.mail.sent).toHaveLength(1);
    expect(t.mail.sent.some((m) => m.to === 'nobody@example.com')).toBe(false);
  });

  it('resets once and ends every earlier session', async () => {
    const { session: earlier } = await signUpVerified(t, { email: EMAIL });
    const oldAccess = earlier.cookie('rr_at') as string;
    expect(oldAccess).toBeDefined();
    await earlier.get('/v1/me').expect(200);
    await t.db.execute(sql`update app_user set failed_logins = 3, locked_until = now() + interval '10 minutes'`);

    const token = await requestLink();
    const res = await reset(token).expect(200);
    expect(res.body).toEqual({ status: 'password_reset' });

    // Read before the old-password login below, which records a failure of its own.
    const row = await userRow();
    expect(row.failed_logins).toBe(0);
    expect(row.locked_until).toBeNull();

    await login(NEW_PASSWORD).expect(200);
    const old = await login(OLD_PASSWORD).expect(401);
    expect(old.body.code).toBe('INVALID_CREDENTIALS');

    const again = await reset(token, 'another-harvest-2028').expect(400);
    expect(again.body).toMatchObject({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired.' });

    // The session that existed before the reset: its refresh cookie is dead, and so is its still-unexpired access token.
    const refreshed = await earlier.post('/v1/auth/refresh').expect(401);
    expect(refreshed.body.code).toBe('INVALID_SESSION');
    const stale = await t.session().get('/v1/me').set('Cookie', `rr_at=${oldAccess}`).expect(401);
    expect(stale.body.code).toBe('INVALID_SESSION');
  });

  it('verifies an unverified user', async () => {
    await t
      .session()
      .post('/v1/auth/signup')
      .send({ name: 'Ayesha Khan', email: EMAIL, password: OLD_PASSWORD, companyName: 'Zarfeen Rice Mills', locale: 'en' })
      .expect(202);
    expect((await userRow()).email_verified_at).toBeNull();

    await reset(await requestLink()).expect(200);
    expect((await userRow()).email_verified_at).not.toBeNull();
  });

  it('a reset link expires after 1 hour', async () => {
    await signUpVerified(t, { email: EMAIL });
    const token = await requestLink();
    const lifetime = await t.db.execute<{ seconds: number }>(
      sql`select round(extract(epoch from (expires_at - created_at)))::int as seconds from email_token where purpose = 'reset' and used_at is null`,
    );
    expect(lifetime.rows[0].seconds).toBe(3600);

    await t.db.execute(sql`update email_token set expires_at = now() - interval '1 second' where purpose = 'reset'`);
    const res = await reset(token).expect(400);
    expect(res.body.code).toBe('INVALID_TOKEN');
    await login(OLD_PASSWORD).expect(200);
  });

  it('a new reset link replaces the earlier one', async () => {
    await signUpVerified(t, { email: EMAIL });
    const first = await requestLink();
    const second = await requestLink();
    expect(second).not.toBe(first);

    expect((await reset(first).expect(400)).body.code).toBe('INVALID_TOKEN');
    await reset(second).expect(200);
  });

  it('rejects a common password and keeps the token usable', async () => {
    await signUpVerified(t, { email: EMAIL });
    const token = await requestLink();

    const res = await reset(token, 'qwertyuiop').expect(400);
    expect(res.body.code).toBe('COMMON_PASSWORD');
    await login(OLD_PASSWORD).expect(200);

    await reset(token).expect(200);
    await login(NEW_PASSWORD).expect(200);
  });

  it('limits forgot password to 5 an hour per email', async () => {
    await signUpVerified(t, { email: EMAIL });
    for (let i = 1; i <= 5; i++) await forgot(i % 2 ? EMAIL : EMAIL.toUpperCase()).expect(202);
    const res = await forgot(` ${EMAIL} `).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('answers 503 EMAIL_CAP_REACHED for every email when today’s cap is used', async () => {
    await signUpVerified(t, { email: EMAIL });
    await t.db.execute(
      sql`insert into email_delivery (id, to_email, kind, status, created_at)
          select gen_random_uuid(), 'seed@example.com', 'verify', 'sent', now() from generate_series(1, 100)`,
    );
    t.mail.sent.length = 0;
    expect((await forgot(EMAIL).expect(503)).body.code).toBe('EMAIL_CAP_REACHED');
    expect((await forgot('nobody@example.com').expect(503)).body.code).toBe('EMAIL_CAP_REACHED');
    expect(t.mail.sent).toHaveLength(0);
  });

  it('refuses an unknown, a used or an expired token without hashing the new password', async () => {
    await signUpVerified(t, { email: EMAIL });
    const used = await requestLink();
    await reset(used).expect(200);
    const expired = await requestLink();
    await t.db.execute(sql`update email_token set expires_at = now() - interval '1 second' where purpose = 'reset' and used_at is null`);

    const hashes = jest.spyOn(passwords, 'hashPassword');
    try {
      for (const token of ['x'.repeat(43), used, expired]) {
        const res = await reset(token, 'another-harvest-2028').expect(400);
        expect(res.body.code).toBe('INVALID_TOKEN');
      }
      expect(hashes).not.toHaveBeenCalled();
    } finally {
      hashes.mockRestore();
    }
  });

  it('limits reset password to 20 an hour per IP', async () => {
    for (let i = 1; i <= 20; i++) expect((await reset(`junk-token-${i}`.padEnd(43, 'x')).expect(400)).body.code).toBe('INVALID_TOKEN');
    const res = await reset('junk-token-21'.padEnd(43, 'x')).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
