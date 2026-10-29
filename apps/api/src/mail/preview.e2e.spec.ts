import { LOCALES } from '@rejectradar/contracts';
import { prepareTestDatabase } from '@rejectradar/db';
import request from 'supertest';
import { createApp } from '../bootstrap';
import { startTestApp, type TestApp, testEnv } from '../testing/test-app';

describe('dev email preview', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp('api_preview');
  });

  afterAll(async () => {
    await t.close();
  });

  it('lists 28 previews', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/v1/dev/emails')
      .expect(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('lang="en"');
    const links = [
      ...res.text.matchAll(/href="(\/v1\/dev\/emails\/[a-z_]+\/[a-z]+)"/g),
    ].map((m) => m[1]);
    expect(links).toHaveLength(28);
    expect(new Set(links).size).toBe(28);
  });

  it('renders every template in every locale', async () => {
    for (const template of ['verify', 'reset', 'invite', 'account_exists', 'payment_failed', 'instant_alert', 'digest']) {
      for (const locale of LOCALES) {
        const res = await request(t.app.getHttpServer())
          .get(`/v1/dev/emails/${template}/${locale}`)
          .expect(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.text).toContain(`lang="${locale}"`);
      }
    }
  });

  it('uses the sample parameters and links back to the app', async () => {
    const verify = await request(t.app.getHttpServer())
      .get('/v1/dev/emails/verify/en')
      .expect(200);
    expect(verify.text).toContain('http://localhost:4200/verify?token=preview');
    const invite = await request(t.app.getHttpServer())
      .get('/v1/dev/emails/invite/en')
      .expect(200);
    expect(invite.text).toContain('Ayesha Khan');
    expect(invite.text).toContain('Zarfeen Rice Mills');
    const exists = await request(t.app.getHttpServer())
      .get('/v1/dev/emails/account_exists/en')
      .expect(200);
    expect(exists.text).toContain('http://localhost:4200/forgot');
  });

  it('shows the sample alerts in the instant and digest emails', async () => {
    const instant = await request(t.app.getHttpServer())
      .get('/v1/dev/emails/instant_alert/en')
      .expect(200);
    expect(instant.text).toContain('Zarfeen Rice Mills');
    expect(instant.text).toContain('http://localhost:4200/alerts');
    const digest = await request(t.app.getHttpServer())
      .get('/v1/dev/emails/digest/hi')
      .expect(200);
    expect(digest.text).toContain('Rice and spices from Pakistan');
    expect(digest.text).toContain('http://localhost:4200/settings');
  });

  it('renders Urdu right to left', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/v1/dev/emails/invite/ur')
      .expect(200);
    expect(res.text).toContain('dir="rtl"');
  });

  it('answers 404 for an unknown template or locale', async () => {
    const template = await request(t.app.getHttpServer())
      .get('/v1/dev/emails/nope/en')
      .expect(404);
    expect(template.body.code).toBe('NOT_FOUND');
    const locale = await request(t.app.getHttpServer())
      .get('/v1/dev/emails/verify/xx')
      .expect(404);
    expect(locale.body.code).toBe('NOT_FOUND');
  });

  it('is not mounted in production', async () => {
    const url = await prepareTestDatabase('api_preview_prod');
    const production = await createApp(
      testEnv(url, {
        NODE_ENV: 'production',
        MAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_test_0123456789abcdef',
      }),
    );
    await production.init();
    try {
      await request(production.getHttpServer())
        .get('/v1/dev/emails')
        .expect(404);
      await request(production.getHttpServer())
        .get('/v1/dev/emails/verify/en')
        .expect(404);
    } finally {
      await production.close();
    }
  });
});
