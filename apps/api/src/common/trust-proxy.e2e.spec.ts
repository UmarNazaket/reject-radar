import type { INestApplication } from '@nestjs/common';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createApp } from '../bootstrap';
import { testEnv } from '../testing/test-app';

// nestjs-pino builds one pino-http logger per process, so this app needs a spec file of its own to own the log stream.
describe('TRUST_PROXY_HOPS=1 (P4-D14)', () => {
  const chunks: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  let app: INestApplication;

  beforeAll(async () => {
    // /v1/health never touches the database, so an unreachable one is fine here.
    app = await createApp(testEnv('postgres://nobody:nothing@127.0.0.1:1/none', { LOG_LEVEL: 'info', TRUST_PROXY_HOPS: '1' }), { logStream });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('takes req.ip from the last X-Forwarded-For hop', async () => {
    await request(app.getHttpServer()).get('/v1/health').set('X-Forwarded-For', '198.51.100.1, 203.0.113.7').expect(200);
    const deadline = Date.now() + 2000;
    while (!chunks.join('').includes('request completed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const completed = chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg?: string; req?: { ip?: string } })
      .find((line) => line.msg === 'request completed');
    expect(completed?.req?.ip).toBe('203.0.113.7');
  });
});
