import { SourceFetchError } from '../core/http';
import { fakeFetcher, fetchResult } from '../core/test-fetcher';
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
  const creds = { user: 'owner@example.com', key: 'k' };
  const json = (body: unknown, status = 200) => fetchResult(JSON.stringify(body), { status, contentType: 'application/json' });

  it('posts JSON with the FDA auth headers through the fetcher', async () => {
    const { fetcher, calls } = fakeFetcher(() => json({ statuscode: 400, message: 'Success.', resultcount: 0, result: [] }));

    const page = await fetchRefusalsPage(fetcher, creds, { from: '2026-07-01', to: '2026-07-31' });

    expect(page).toEqual({ records: [], total: null });
    expect(calls[0].url).toBe('https://api-datadashboard.fda.gov/v1/import_refusals');
    expect(calls[0].options).toMatchObject({ method: 'POST', expect: 'json', acceptClientErrors: true });
    expect(calls[0].options?.headers).toMatchObject({ 'Authorization-User': 'owner@example.com', 'Authorization-Key': 'k' });
    expect(JSON.parse(String(calls[0].options?.body))).toMatchObject({ filters: { RefusalDateFrom: ['2026-07-01'] } });
  });

  it('keeps the HTTP status on a non-JSON error body', async () => {
    const { fetcher } = fakeFetcher(() => fetchResult('upstream connect error', { status: 502, contentType: 'text/plain' }));
    const error = await fetchRefusalsPage(fetcher, creds, { from: 'a', to: 'b' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceFetchError);
    expect((error as SourceFetchError).status).toBe(502);
    expect((error as SourceFetchError).message).toContain('HTTP 502');
    expect((error as SourceFetchError).url).toBe('https://api-datadashboard.fda.gov/v1/import_refusals');
  });

  it('keeps the HTTP status when the FDA status is an error', async () => {
    const { fetcher } = fakeFetcher(() => json({ statuscode: 406, message: 'Invalid column names', invalid_columns: ['Firm'] }, 406));
    const error = await fetchRefusalsPage(fetcher, creds, { from: 'a', to: 'b' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceFetchError);
    expect((error as SourceFetchError).status).toBe(406);
    expect((error as SourceFetchError).message).toContain('FDA API error 406: Invalid column names');
  });
});
