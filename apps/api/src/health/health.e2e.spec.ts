import { type INestApplication, Logger } from '@nestjs/common';
import { apiEnvSchema, type ApiEnv, parseEnv } from '@rejectradar/contracts';
import { prepareTestDatabase } from '@rejectradar/db';
import request from 'supertest';
import { createApp } from '../bootstrap';

const SECRET = 'qL8vT2nX5rW9yB3mK7pD1sF6hJ4gZ0cA2eR8tY5uI3o';

function testEnv(databaseUrl: string): ApiEnv {
  return parseEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    JWT_SECRET: SECRET,
    APP_ORIGIN: 'http://localhost:4200',
  });
}

describe('health endpoints', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(testEnv(await prepareTestDatabase('api')));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/health answers without touching the database', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /v1/health/ready checks the database', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('returns the standard error shape with the request id header', async () => {
    const res = await request(app.getHttpServer()).get('/v1/does-not-exist').expect(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String), requestId: res.headers['x-request-id'] });
  });

  it('reuses a well-formed x-request-id and replaces a malformed one', async () => {
    const good = await request(app.getHttpServer()).get('/v1/health').set('x-request-id', 'abc12345-test').expect(200);
    expect(good.headers['x-request-id']).toBe('abc12345-test');
    const bad = await request(app.getHttpServer()).get('/v1/health').set('x-request-id', 'bad id <script>').expect(200);
    expect(bad.headers['x-request-id']).not.toContain('<script>');
  });

  it('only allows credentialed CORS for APP_ORIGIN', async () => {
    const ok = await request(app.getHttpServer()).get('/v1/health').set('Origin', 'http://localhost:4200');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const other = await request(app.getHttpServer()).get('/v1/health').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('sends security headers from helmet', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('health when the database is unreachable', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(testEnv('postgres://nobody:nothing@127.0.0.1:1/none'));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('still boots and serves /v1/health', async () => {
    await request(app.getHttpServer()).get('/v1/health').expect(200);
  });

  it('answers 503 DB_UNAVAILABLE on /v1/health/ready', async () => {
    const res = await request(app.getHttpServer()).get('/v1/health/ready').expect(503);
    expect(res.body.code).toBe('DB_UNAVAILABLE');
  });

  it('logs why the readiness check failed', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      await request(app.getHttpServer()).get('/v1/health/ready').expect(503);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.objectContaining({ code: 'ECONNREFUSED' }) }),
        'Database readiness check failed',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
