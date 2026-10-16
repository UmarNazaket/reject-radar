import { Readable } from 'node:stream';
import { readCsvSummary } from './read-csv-summary';

describe('readCsvSummary', () => {
  it('handles a BOM, CRLF line endings, quoted commas and ragged rows', async () => {
    const csv =
      '\uFEFFFail_Date,Producer_Name,Country\r\n' +
      '2026-07-01,"Acme Foods, Pvt Ltd",Pakistan\r\n' +
      '2026-07-02,,India\r\n' +
      '2026-07-03,Beta Rice\r\n';
    const summary = await readCsvSummary(Readable.from([csv]), ['Country', 'producer_name']);
    expect(summary.headers).toEqual(['fail_date', 'producer_name', 'country']);
    expect(summary.rows).toBe(3);
    expect(summary.fillRates).toEqual({ country: 0.6667, producer_name: 0.6667 });
  });

  it('returns zero rows and zero fill rates for a header-only file', async () => {
    const summary = await readCsvSummary(Readable.from(['a,b\n']), ['a']);
    expect(summary).toEqual({ headers: ['a', 'b'], rows: 0, fillRates: { a: 0 } });
  });
});
