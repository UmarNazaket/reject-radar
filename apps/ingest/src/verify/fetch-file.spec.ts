import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeFetcher, fetchResult } from '../core/test-fetcher';
import { downloadFile } from './fetch-file';

describe('downloadFile', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fetch-file-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves the response body under the URL file name and passes the expectation on', async () => {
    const { fetcher, calls } = fakeFetcher((url) => fetchResult('a,b\n1,2\n', { contentType: 'text/csv', url }));
    const target = await downloadFile(fetcher, 'https://data.gov.au/files/rows.csv', dir, 'csv');
    expect(target).toBe(path.join(dir, 'rows.csv'));
    expect(await readFile(target, 'utf8')).toBe('a,b\n1,2\n');
    expect(calls[0]).toEqual({ url: 'https://data.gov.au/files/rows.csv', options: { expect: 'csv' } });
  });

  it('falls back to download.bin when the URL has no file name', async () => {
    const { fetcher } = fakeFetcher((url) => fetchResult('x', { url }));
    expect(await downloadFile(fetcher, 'https://data.gov.au/', dir)).toBe(path.join(dir, 'download.bin'));
  });
});
