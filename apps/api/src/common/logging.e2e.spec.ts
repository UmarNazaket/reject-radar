import type { INestApplication } from '@nestjs/common';
import { prepareTestDatabase } from '@rejectradar/db';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createApp } from '../bootstrap';
import { reqSerializer, resSerializer } from './logging';
import { testEnv } from '../testing/test-app';

/** pino-http writes the completion line when the response finishes, which can be just after supertest resolves. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the log line');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('request logging', () => {
  const chunks: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logged = (text: string) => waitFor(() => chunks.join('').includes(text));
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp(testEnv(await prepareTestDatabase('api_logging'), { LOG_LEVEL: 'info' }), { logStream });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps secrets, query strings and unlisted headers out of the log', async () => {
    chunks.length = 0;
    await request(app.getHttpServer())
      .get('/v1/health?token=abc123secret')
      .set('Authorization', 'Bearer tok_secret_1')
      .set('Cookie', 'rr_at=cookie_secret_2; rr_rt=cookie_secret_3')
      .set('User-Agent', 'logging-spec')
      .expect(200);

    await logged('request completed');
    const text = chunks.join('');
    for (const secret of ['abc123secret', 'tok_secret_1', 'cookie_secret_2', 'cookie_secret_3']) {
      expect(text).not.toContain(secret);
    }

    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg?: string; req?: Record<string, unknown> & { headers?: Record<string, string> }; res?: Record<string, unknown> });
    const completed = lines.find((line) => line.msg === 'request completed');
    expect(completed?.req?.['url']).toBe('/v1/health');
    expect(completed?.req?.['method']).toBe('GET');
    expect(completed?.req?.headers?.['user-agent']).toBe('logging-spec');
    expect(Object.keys(completed?.req?.['headers'] ?? {}).filter(
      (key) => !['user-agent', 'content-type', 'content-length', 'origin', 'x-request-id'].includes(key),
    )).toEqual([]);
    expect(completed?.res?.['statusCode']).toBe(200);
    expect(completed?.res?.['headers']).not.toHaveProperty('set-cookie');
  });

  it('resSerializer keeps only content-type and content-length, so Set-Cookie never reaches the log', () => {
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    res.setHeader('Set-Cookie', ['rr_at=set_cookie_secret_4; HttpOnly']);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', '2');
    res.setHeader('X-Other', 'dropped');
    expect(resSerializer(res)).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'content-length': '2' },
    });
  });

  it('reqSerializer drops the query and every header outside the allow-list', () => {
    const req = Object.assign(new IncomingMessage(new Socket()), {
      id: 'req-1',
      method: 'POST',
      url: '/v1/auth/reset?token=abc#frag',
      ip: '203.0.113.9',
      headers: { cookie: 'rr_at=x', authorization: 'Bearer y', origin: 'http://localhost:4200', 'user-agent': 'ua' },
    });
    expect(reqSerializer(req)).toEqual({
      id: 'req-1',
      method: 'POST',
      url: '/v1/auth/reset',
      ip: '203.0.113.9',
      headers: { origin: 'http://localhost:4200', 'user-agent': 'ua' },
    });
  });
});
