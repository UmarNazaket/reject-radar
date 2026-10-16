import { buildRefusalsBody, fetchRefusalsPage, interpretFdaResponse } from './fda-api';

describe('buildRefusalsBody', () => {
  it('sends the required keys and only the optional keys in use', () => {
    expect(buildRefusalsBody({ from: '2026-07-01', to: '2026-07-31' })).toEqual({
      columns: [],
      filters: { RefusalDateFrom: ['2026-07-01'], RefusalDateTo: ['2026-07-31'] },
      sort: '',
      sortorder: 'asc',
      rows: 5000,
      start: 1,
    });
    expect(buildRefusalsBody({ from: 'a', to: 'b', countTotal: true, rows: 9000, start: 5001 })).toMatchObject({
      rows: 5000,
      start: 5001,
      returntotalcount: true,
    });
  });
});

describe('interpretFdaResponse (review focus 5)', () => {
  it('treats statuscode 400 with "Success." as success', () => {
    expect(
      interpretFdaResponse({ statuscode: 400, message: 'Success.', resultcount: 1, totalrecordcount: 7, result: [{ FirmName: 'Acme' }] }),
    ).toEqual({ records: [{ FirmName: 'Acme' }], total: 7 });
  });
  it('treats 412 as no results', () => {
    expect(interpretFdaResponse({ statuscode: 412, message: 'No results' })).toEqual({ records: [], total: 0 });
  });
  it('reports errors with the invalid fields', () => {
    expect(() => interpretFdaResponse({ statuscode: 406, message: 'Invalid column names', invalid_columns: ['Firm'] })).toThrow(
      'FDA API error 406: Invalid column names (invalid_columns: ["Firm"])',
    );
  });
  it('reports an authorisation failure', () => {
    expect(() => interpretFdaResponse({ statuscode: 401, message: 'Not authorized' })).toThrow('FDA API error 401: Not authorized');
  });
});

describe('fetchRefusalsPage', () => {
  const originalContact = process.env['INGEST_CONTACT_EMAIL'];

  beforeAll(() => {
    process.env['INGEST_CONTACT_EMAIL'] = 'test@example.com';
  });

  afterAll(() => {
    if (originalContact === undefined) delete process.env['INGEST_CONTACT_EMAIL'];
    else process.env['INGEST_CONTACT_EMAIL'] = originalContact;
  });

  it('posts JSON with the FDA auth headers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ statuscode: 400, message: 'Success.', resultcount: 0, result: [] }));
    }) as unknown as typeof fetch;

    const page = await fetchRefusalsPage({ user: 'owner@example.com', key: 'k' }, { from: '2026-07-01', to: '2026-07-31' }, fakeFetch);

    expect(page).toEqual({ records: [], total: null });
    expect(calls[0].url).toBe('https://api-datadashboard.fda.gov/v1/import_refusals');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ 'Authorization-User': 'owner@example.com', 'Authorization-Key': 'k' });
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ filters: { RefusalDateFrom: ['2026-07-01'] } });
  });

  it('explains a body that is not JSON', async () => {
    const fakeFetch = (async () => new Response('<html>maintenance</html>', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchRefusalsPage({ user: 'u', key: 'k' }, { from: 'a', to: 'b' }, fakeFetch)).rejects.toThrow('HTTP 503');
  });
});
