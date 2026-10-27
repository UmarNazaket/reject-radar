import { translate } from '@rejectradar/i18n';
import { sql } from 'drizzle-orm';
import { startTestApp, type TestApp } from '../testing/test-app';

const SIGNUP = {
  name: 'Sara Malik',
  email: ' Ayesha.Khan@Example.COM ',
  password: 'zarfeen-rice-2026',
  companyName: 'Zarfeen Rice Mills',
  locale: 'ur',
};
const EMAIL = 'ayesha.khan@example.com';

describe('sign-up, email verification and resend', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp('api_signup');
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.resetRateLimits();
    t.mail.sent.length = 0;
    await t.db.execute(sql`truncate app_user, org, email_delivery cascade`);
  });

  const count = async (table: 'app_user' | 'org' | 'membership' | 'subscription' | 'email_token') => {
    const result = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`);
    return result.rows[0].n;
  };
  const signup = (body: object = SIGNUP) => t.session().post('/v1/auth/signup').send(body);
  const tokenFrom = (email: string) => t.mail.linkIn(t.mail.lastTo(email)).searchParams.get('token') as string;
  const verify = (token: string) => t.session().post('/v1/auth/verify-email').send({ token });

  it('creates the account, owner, free subscription and a verify email in the chosen language', async () => {
    const res = await signup().expect(202);
    expect(res.body).toEqual({ status: 'check_email' });
    expect(res.headers['set-cookie']).toBeUndefined();

    const users = await t.db.execute<{ email: string; locale: string; email_verified_at: string | null; password_hash: string }>(
      sql`select email, locale, email_verified_at, password_hash from app_user`,
    );
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]).toMatchObject({ email: EMAIL, locale: 'ur', email_verified_at: null });
    expect(users.rows[0].password_hash).toMatch(/^\$argon2id\$/);

    const members = await t.db.execute<{ role: string }>(sql`select role from membership`);
    expect(members.rows).toEqual([{ role: 'owner' }]);
    const subscriptions = await t.db.execute<{ plan: string; status: string }>(sql`select plan, status from subscription`);
    expect(subscriptions.rows).toEqual([{ plan: 'free', status: 'active' }]);
    const orgs = await t.db.execute<{ name: string }>(sql`select name from org`);
    expect(orgs.rows).toEqual([{ name: 'Zarfeen Rice Mills' }]);

    const message = t.mail.lastTo(EMAIL);
    expect(message.subject).toBe(translate('ur', 'email.verify.subject'));
    expect(t.mail.linkIn(message).href).toMatch(/^http:\/\/localhost:4200\/verify\?token=[A-Za-z0-9_-]{43}$/);
  });

  it('answers the same for an existing email and sends account_exists', async () => {
    await signup().expect(202);
    const res = await signup({ ...SIGNUP, email: 'AYESHA.KHAN@example.com', locale: 'en', name: 'Someone Else' }).expect(202);
    expect(res.body).toEqual({ status: 'check_email' });
    expect(await count('app_user')).toBe(1);
    expect(await count('org')).toBe(1);

    const message = t.mail.lastTo(EMAIL);
    expect(message.subject).toBe(translate('ur', 'email.accountExists.subject'));
    expect(t.mail.linkIn(message).href).toBe('http://localhost:4200/login');
    expect(message.text).toContain('http://localhost:4200/forgot');
  });

  it('two parallel sign-ups make one account', async () => {
    const [a, b] = await Promise.all([signup(), signup({ ...SIGNUP, email: 'Ayesha.Khan@example.com' })]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(await count('app_user')).toBe(1);
    expect(await count('org')).toBe(1);
    const subjects = t.mail.sent.filter((m) => m.to === EMAIL).map((m) => m.subject);
    expect(subjects.sort()).toEqual([translate('ur', 'email.accountExists.subject'), translate('ur', 'email.verify.subject')].sort());
  });

  it('rejects a common password', async () => {
    const res = await signup({ ...SIGNUP, password: 'qwertyuiop' }).expect(400);
    expect(res.body).toMatchObject({ code: 'COMMON_PASSWORD' });
    expect(await count('app_user')).toBe(0);
    expect(await count('org')).toBe(0);
    expect(t.mail.sent).toHaveLength(0);
  });

  it('rejects a 300-character password before hashing', async () => {
    const res = await signup({ ...SIGNUP, password: 'a'.repeat(300) }).expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.details.issues[0].path).toBe('password');
    expect(await count('app_user')).toBe(0);
  });

  it('verifies once', async () => {
    await signup().expect(202);
    const token = tokenFrom(EMAIL);
    const res = await verify(token).expect(200);
    expect(res.body).toEqual({ status: 'verified' });
    const users = await t.db.execute<{ email_verified_at: string | null }>(sql`select email_verified_at from app_user`);
    expect(users.rows[0].email_verified_at).not.toBeNull();

    const again = await verify(token).expect(400);
    expect(again.body).toMatchObject({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired.' });
  });

  it('refuses a token that was never issued', async () => {
    const res = await verify('x'.repeat(43)).expect(400);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('refuses an expired verify link', async () => {
    await signup().expect(202);
    const token = tokenFrom(EMAIL);
    await t.db.execute(sql`update email_token set expires_at = now() - interval '1 second'`);
    const res = await verify(token).expect(400);
    expect(res.body.code).toBe('INVALID_TOKEN');
    const users = await t.db.execute<{ email_verified_at: string | null }>(sql`select email_verified_at from app_user`);
    expect(users.rows[0].email_verified_at).toBeNull();
  });

  it('resend replaces the earlier link', async () => {
    await signup().expect(202);
    const oldToken = tokenFrom(EMAIL);
    const sentBefore = t.mail.sent.length;

    const res = await t.session().post('/v1/auth/resend-verification').send({ email: ' AYESHA.khan@example.com ' }).expect(202);
    expect(res.body).toEqual({ status: 'check_email' });
    expect(t.mail.sent).toHaveLength(sentBefore + 1);
    expect(t.mail.lastTo(EMAIL).subject).toBe(translate('ur', 'email.verify.subject'));
    const newToken = tokenFrom(EMAIL);
    expect(newToken).not.toBe(oldToken);

    expect((await verify(oldToken).expect(400)).body.code).toBe('INVALID_TOKEN');
    await verify(newToken).expect(200);
  });

  it('resend answers the same for an unknown or already verified email and sends nothing', async () => {
    const unknown = await t.session().post('/v1/auth/resend-verification').send({ email: 'nobody@example.com' }).expect(202);
    expect(unknown.body).toEqual({ status: 'check_email' });
    expect(t.mail.sent).toHaveLength(0);

    await signup().expect(202);
    await verify(tokenFrom(EMAIL)).expect(200);
    const sentBefore = t.mail.sent.length;
    const verified = await t.session().post('/v1/auth/resend-verification').send({ email: EMAIL }).expect(202);
    expect(verified.body).toEqual({ status: 'check_email' });
    expect(t.mail.sent).toHaveLength(sentBefore);
  });

  it('limits sign-ups to 5 an hour per IP', async () => {
    for (let i = 1; i <= 5; i++) await signup({ ...SIGNUP, email: `person${i}@example.com` }).expect(202);
    const res = await signup({ ...SIGNUP, email: 'person6@example.com' }).expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(await count('app_user')).toBe(5);
  });

  it('limits resends to 3 an hour per email', async () => {
    for (let i = 1; i <= 3; i++) await t.session().post('/v1/auth/resend-verification').send({ email: EMAIL }).expect(202);
    const res = await t.session().post('/v1/auth/resend-verification').send({ email: EMAIL.toUpperCase() }).expect(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('answers 503 EMAIL_CAP_REACHED and writes nothing when today’s cap is used', async () => {
    await t.db.execute(
      sql`insert into email_delivery (id, to_email, kind, status, created_at)
          select gen_random_uuid(), 'seed@example.com', 'verify', 'sent', now() from generate_series(1, 100)`,
    );
    const res = await signup().expect(503);
    expect(res.body.code).toBe('EMAIL_CAP_REACHED');
    expect(await count('org')).toBe(0);
    expect(await count('app_user')).toBe(0);
    expect(t.mail.sent).toHaveLength(0);
  });
});
