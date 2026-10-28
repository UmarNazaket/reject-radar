import { Writable } from 'node:stream';
import { signUpVerified, startTestApp, type TestApp } from '../testing/test-app';

/** pino-http writes the completion line when the response finishes, which can be just after supertest resolves. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the log line');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface LogLine {
  msg?: string;
  userId?: string;
  orgId?: string;
  req?: { url?: string };
}

// nestjs-pino keeps one logger per process, so the log assertions have their own spec file.
describe('request logs of an authenticated call', () => {
  const chunks: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp('api_me_logging', { logStream }, { LOG_LEVEL: 'info' });
  });

  afterAll(async () => {
    await t.close();
  });

  const lines = (): LogLine[] =>
    chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine);
  const completed = (url: string) => lines().find((line) => line.msg === 'request completed' && line.req?.url === url);

  it('request logs carry userId and orgId', async () => {
    const { session, userId, orgId } = await signUpVerified(t, { email: 'me.logging@example.com' });
    chunks.length = 0;
    await session.get('/v1/me').expect(200);
    await waitFor(() => completed('/v1/me') !== undefined);
    expect(completed('/v1/me')).toMatchObject({ userId, orgId });
  });

  it('a public call logs no user', async () => {
    chunks.length = 0;
    await t.session().get('/v1/health').expect(200);
    await waitFor(() => completed('/v1/health') !== undefined);
    expect(completed('/v1/health')).not.toHaveProperty('userId');
    expect(completed('/v1/health')).not.toHaveProperty('orgId');
  });
});
