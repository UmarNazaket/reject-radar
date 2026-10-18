import { createHash } from 'node:crypto';
import { createFetcher, HOST_MIN_INTERVAL_MS, SOURCE_HOSTS, SourceFetchError } from './http';

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;

function setup(handlers: Handler[], options: { now?: () => number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const handler = handlers[Math.min(index++, handlers.length - 1)];
    return handler(url, init);
  }) as unknown as typeof fetch;
  const fetcher = createFetcher({
    contact: 'ops@example.com',
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: options.now ?? (() => 0),
  });
  return { fetcher, calls, sleeps };
}

const ok = (body = 'ok', headers: Record<string, string> = { 'content-type': 'text/plain' }): Handler => () =>
  new Response(body, { status: 200, headers });
const status = (code: number, headers: Record<string, string> = {}): Handler => () =>
  new Response(`status ${code}`, { status: code, headers: { 'content-type': 'text/plain', ...headers } });
const redirect = (location: string, code = 302): Handler => () => new Response(null, { status: code, headers: { location } });
const networkError: Handler = () => {
  throw new TypeError('fetch failed');
};

async function failure(promise: Promise<unknown>): Promise<SourceFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceFetchError);
    return error as SourceFetchError;
  }
  throw new Error('expected the fetch to fail');
}

describe('createFetcher', () => {
  it('exposes the allow-list and the accessdata spacing', () => {
    expect(SOURCE_HOSTS).toContain('www.accessdata.fda.gov');
    expect(HOST_MIN_INTERVAL_MS['www.accessdata.fda.gov']).toBe(30_000);
  });

  it('rejects a host outside the allow-list', async () => {
    const { fetcher, calls } = setup([ok()]);
    const error = await failure(fetcher('https://evil.example/x'));
    expect(error.status).toBeNull();
    expect(error.url).toBe('https://evil.example/x');
    expect(error.message).toContain('evil.example');
    expect(calls).toHaveLength(0);
  });

  it('rejects plain http and malformed URLs', async () => {
    const { fetcher, calls } = setup([ok()]);
    expect((await failure(fetcher('http://data.gov.au/x'))).status).toBeNull();
    expect((await failure(fetcher('not a url'))).status).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('re-checks the allow-list on redirects', async () => {
    const bad = setup([redirect('https://evil.example/')]);
    const error = await failure(bad.fetcher('https://data.gov.au/start'));
    expect(error.message).toContain('evil.example');
    expect(bad.calls).toHaveLength(1);

    const good = setup([redirect('https://ckan.publishing.service.gov.uk/file.csv'), ok('a,b')]);
    const result = await good.fetcher('https://www.data.gov.uk/start');
    expect(result.url).toBe('https://ckan.publishing.service.gov.uk/file.csv');
    expect(result.text()).toBe('a,b');
    expect(good.calls.map((call) => call.url)).toEqual([
      'https://www.data.gov.uk/start',
      'https://ckan.publishing.service.gov.uk/file.csv',
    ]);
  });

  it('follows relative redirects and gives up after 5 hops', async () => {
    const relative = setup([redirect('/next'), ok('done')]);
    expect((await relative.fetcher('https://data.gov.au/a')).url).toBe('https://data.gov.au/next');

    const loop = setup([redirect('/again')]);
    const error = await failure(loop.fetcher('https://data.gov.au/a'));
    expect(error.message).toContain('redirect');
    expect(loop.calls).toHaveLength(6);
  });

  it('turns a POST into a GET after a 303 and drops custom headers on another host', async () => {
    const { fetcher, calls } = setup([redirect('https://datadashboard.fda.gov/x', 303), ok()]);
    await fetcher('https://api-datadashboard.fda.gov/v1', { method: 'POST', body: '{}', headers: { 'Authorization-Key': 'secret' } });
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].init.body).toBeUndefined();
    expect(calls[1].init.headers).not.toHaveProperty('Authorization-Key');
  });

  it('sends the contact User-Agent', async () => {
    const { fetcher, calls } = setup([ok()]);
    await fetcher('https://data.gov.au/x', { headers: { 'User-Agent': 'spoof', Accept: 'text/csv' } });
    expect(calls[0].init.headers).toMatchObject({ 'User-Agent': 'RejectRadar data sync (ops@example.com)', Accept: 'text/csv' });
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('waits 30 s between accessdata requests and 1 s elsewhere', async () => {
    const fda = setup([ok()]);
    await fda.fetcher('https://www.accessdata.fda.gov/a');
    await fda.fetcher('https://www.accessdata.fda.gov/b');
    expect(fda.sleeps).toEqual([30_000]);

    const au = setup([ok()]);
    await au.fetcher('https://data.gov.au/a');
    await au.fetcher('https://data.gov.au/b');
    expect(au.sleeps).toEqual([1_000]);
  });

  it('does not wait when enough time has passed or the host differs', async () => {
    let time = 0;
    const { fetcher, sleeps } = setup([ok()], { now: () => time });
    await fetcher('https://data.gov.au/a');
    await fetcher('https://www.data.gov.uk/a');
    time = 1_500;
    await fetcher('https://data.gov.au/b');
    expect(sleeps).toEqual([]);
  });

  it('retries 429 and 5xx with back-off', async () => {
    const mixed = setup([status(503), status(429, { 'retry-after': '5' }), ok('fine')]);
    const result = await mixed.fetcher('https://data.gov.au/x');
    expect(result.status).toBe(200);
    expect(result.text()).toBe('fine');
    expect(mixed.sleeps).toEqual([2_000, 5_000]);

    const dead = setup([status(503)]);
    const error = await failure(dead.fetcher('https://data.gov.au/x'));
    expect(error.status).toBe(503);
    expect(dead.calls).toHaveLength(4);
    expect(dead.sleeps).toEqual([2_000, 8_000, 30_000]);
  });

  it('retries network errors and reports status null when they persist', async () => {
    const flaky = setup([networkError, ok('back')]);
    expect((await flaky.fetcher('https://data.gov.au/x')).text()).toBe('back');
    expect(flaky.sleeps).toEqual([2_000]);

    const down = setup([networkError]);
    const error = await failure(down.fetcher('https://data.gov.au/x', { retries: 1 }));
    expect(error.status).toBeNull();
    expect(error.message).toContain('fetch failed');
    expect(down.calls).toHaveLength(2);
  });

  it('does not retry other 4xx', async () => {
    const { fetcher, calls } = setup([status(404)]);
    const error = await failure(fetcher('https://data.gov.au/x'));
    expect(error.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('returns a 4xx to callers that read the error body themselves', async () => {
    const { fetcher } = setup([status(406)]);
    const result = await fetcher('https://data.gov.au/x', { acceptClientErrors: true });
    expect(result.status).toBe(406);
  });

  it.each([
    ['a text/html content type', () => new Response('a,b', { headers: { 'content-type': 'text/html; charset=utf-8' } })],
    ['a DOCTYPE body', () => new Response('<!DOCTYPE html><title>x</title>', { headers: { 'content-type': 'text/csv' } })],
    ['an html body', () => new Response('\uFEFF  <html><body>blocked</body></html>', { headers: { 'content-type': 'text/csv' } })],
  ])('rejects HTML when CSV was expected (%s)', async (_label, handler) => {
    const { fetcher } = setup([handler]);
    const error = await failure(fetcher('https://data.gov.au/x', { expect: 'csv' }));
    expect(error.message).toContain('expected csv');
    expect(error.status).toBe(200);
  });

  it('rejects HTML when JSON was expected but allows it for html and any', async () => {
    const html = () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    expect((await failure(setup([html]).fetcher('https://data.gov.au/x', { expect: 'json' }))).message).toContain('expected json');
    expect((await setup([html]).fetcher('https://data.gov.au/x', { expect: 'html' })).text()).toBe('<html></html>');
    expect((await setup([html]).fetcher('https://data.gov.au/x')).text()).toBe('<html></html>');
  });

  it('times out', async () => {
    const hang = (() => new Promise<Response>(() => undefined)) as Handler;
    const { fetcher } = setup([hang]);
    const error = await failure(fetcher('https://data.gov.au/x', { timeoutMs: 50, retries: 0 }));
    expect(error.message).toContain('timed out');
    expect(error.status).toBeNull();
  });

  it('sniffs only the head of the body for HTML', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x61);
    const decoded: number[] = [];
    const original = Buffer.prototype.toString;
    const spy = jest.spyOn(Buffer.prototype, 'toString').mockImplementation(function (this: Buffer, ...args: unknown[]) {
      const out = original.apply(this, args as [BufferEncoding?, number?, number?]);
      decoded.push(out.length);
      return out;
    });
    try {
      const binary = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]), big]);
      const accepted = await setup([() => new Response(binary, { headers: { 'content-type': 'application/octet-stream' } })]).fetcher(
        'https://data.gov.au/x.zip',
        { expect: 'csv' },
      );
      expect(accepted.bytes.length).toBe(binary.length);
      expect(Math.max(...decoded)).toBeLessThanOrEqual(512);

      const html = Buffer.concat([Buffer.from('<!DOCTYPE html><title>blocked</title>'), big]);
      const rejected = setup([() => new Response(html, { headers: { 'content-type': 'text/csv' } })]).fetcher('https://data.gov.au/x', {
        expect: 'csv',
      });
      await expect(rejected).rejects.toThrow('expected csv');
      expect(Math.max(...decoded)).toBeLessThanOrEqual(512);
    } finally {
      spy.mockRestore();
    }
  });

  it('hashes the body and decodes it', async () => {
    const { fetcher } = setup([ok('{"a":1}', { 'content-type': 'application/json' })]);
    const result = await fetcher('https://data.gov.au/x', { expect: 'json' });
    expect(result.sha256).toBe(createHash('sha256').update(Buffer.from('{"a":1}')).digest('hex'));
    expect(result.bytes).toEqual(Buffer.from('{"a":1}'));
    expect(result.contentType).toBe('application/json');
    expect(result.json<{ a: number }>()).toEqual({ a: 1 });
  });
});
