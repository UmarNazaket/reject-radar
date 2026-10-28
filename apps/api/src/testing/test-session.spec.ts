import { createServer, type Server } from 'node:http';
import { TestSession } from './test-app';

/** A bare HTTP server standing in for the app: routes that set cookies, and one that echoes what it received. */
function cookieServer(): Server {
  return createServer((req, res) => {
    switch (req.url) {
      case '/set-two':
        res.setHeader('Set-Cookie', ['a=alpha; Path=/; HttpOnly; Secure', 'b=beta; Path=/v1/auth; Max-Age=60']);
        break;
      case '/delete-a':
        res.setHeader('Set-Cookie', 'a=; Path=/; Max-Age=0');
        break;
      case '/expire-b':
        res.setHeader('Set-Cookie', 'b=; Path=/v1/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        break;
      case '/value-with-equals':
        res.setHeader('Set-Cookie', 'c=x.y=z==; Path=/');
        break;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, csrf: req.headers['x-rejectradar-csrf'] ?? null }));
  });
}

describe('TestSession cookie jar', () => {
  let server: Server;
  let session: TestSession;

  beforeAll(async () => {
    server = cookieServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    session = new TestSession({ getHttpServer: () => server });
  });

  const echo = async () => (await session.get('/echo')).body as { cookie: string | null; csrf: string | null };

  it('stores every cookie when one response has several Set-Cookie headers', async () => {
    await session.get('/set-two');
    expect(session.cookie('a')).toBe('alpha');
    expect(session.cookie('b')).toBe('beta');
    expect((await echo()).cookie).toBe('a=alpha; b=beta');
  });

  it('deletes a cookie answered with Max-Age=0', async () => {
    await session.get('/set-two');
    await session.get('/delete-a');
    expect(session.cookie('a')).toBeUndefined();
    expect(session.cookie('b')).toBe('beta');
    expect((await echo()).cookie).toBe('b=beta');
  });

  it('deletes a cookie answered with an Expires in the past', async () => {
    await session.get('/set-two');
    await session.get('/expire-b');
    expect(session.cookie('b')).toBeUndefined();
    expect((await echo()).cookie).toBe('a=alpha');
  });

  it('keeps a value that contains "="', async () => {
    await session.get('/value-with-equals');
    expect(session.cookie('c')).toBe('x.y=z==');
  });

  it('sends the cookies of an earlier response on a later request', async () => {
    expect((await echo()).cookie).toBeNull();
    await session.get('/set-two');
    expect((await echo()).cookie).toBe('a=alpha; b=beta');
  });

  it('builds the Cookie header when the request is sent, not when it is created', async () => {
    const early = session.get('/echo');
    await session.get('/set-two');
    expect((await early).body.cookie).toBe('a=alpha; b=beta');
  });

  it('lets a spec send its own Cookie header', async () => {
    await session.get('/set-two');
    const res = await session.get('/echo').set('Cookie', 'a=other');
    expect(res.body.cookie).toBe('a=other');
  });

  it('adds the CSRF header to unsafe methods only', async () => {
    expect((await session.get('/echo')).body.csrf).toBeNull();
    expect((await session.post('/echo')).body.csrf).toBe('1');
  });

  it('keeps separate jars per session', async () => {
    await session.get('/set-two');
    const other = new TestSession({ getHttpServer: () => server });
    expect((await other.get('/echo')).body.cookie).toBeNull();
  });
});
