import { BULK_LIMITS } from '@rejectradar/contracts';
import { AppError } from '../common/errors';
import { parseBulkCsv, type BulkInputRow } from './bulk-csv';

/** Feeds `bytes` in chunks of `size`, so a multi-byte character can be cut in half. */
async function* chunked(bytes: Buffer, size = 7): AsyncGenerator<Buffer> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

const parseText = (text: string, size?: number) => parseBulkCsv(chunked(Buffer.from(text, 'utf8'), size));

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the parse to be rejected');
}

const PLAIN = [
  'name,country,city,fei',
  'Acme Foods,Pakistan,Karachi,3001234567',
  '"Foods, Ltd",pk,Lahore,',
  'Zürich Café Co,India,,',
  '',
].join('\n');

const EXPECTED: BulkInputRow[] = [
  { rowNr: 1, name: 'Acme Foods', countryCode: 'PK', city: 'Karachi', fei: '3001234567' },
  { rowNr: 2, name: 'Foods, Ltd', countryCode: 'PK', city: 'Lahore', fei: null },
  { rowNr: 3, name: 'Zürich Café Co', countryCode: 'IN', city: null, fei: null },
];

describe('parseBulkCsv', () => {
  it('parses a plain file', async () => {
    await expect(parseText(PLAIN)).resolves.toEqual(EXPECTED);
  });

  it('gives the same rows however the bytes are chunked', async () => {
    for (const size of [1, 2, 3, 5, 64, 100000]) await expect(parseText(PLAIN, size)).resolves.toEqual(EXPECTED);
  });

  it("handles Excel's habits: BOM, semicolons, CRLF, quotes, trailing blank lines and odd headers", async () => {
    const excel =
      String.fromCharCode(0xfeff) + ' Name ;COUNTRY;City;FEI\r\n' +
      'Acme Foods;Pakistan;Karachi;3001234567\r\n' +
      '"Foods, Ltd";pk;Lahore;\r\n' +
      'Zürich Café Co;India;;\r\n' +
      '\r\n;;;\r\n\r\n';
    await expect(parseText(excel)).resolves.toEqual(EXPECTED);
  });

  it('ignores unknown columns and takes columns in any order', async () => {
    const rows = await parseText('Notes,Country,NAME\nhi,Pakistan,Acme Foods\n');
    expect(rows).toEqual([{ rowNr: 1, name: 'Acme Foods', countryCode: 'PK', city: null, fei: null }]);
  });

  it('rejects Windows-1252 rather than garbling a name', async () => {
    const bytes = Buffer.concat([Buffer.from('name,country\nCaf'), Buffer.from([0xe9]), Buffer.from(' Foods,PK\n')]);
    const error = await rejection(parseBulkCsv(chunked(bytes)));
    expect(error.code).toBe('INVALID_ENCODING');
    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('CSV UTF-8');
  });

  it('rejects a multi-byte character cut off at the end of the file', async () => {
    const bytes = Buffer.concat([Buffer.from('name,country\nAcme Foods,PK\nCaf'), Buffer.from([0xc3])]);
    expect((await rejection(parseBulkCsv(chunked(bytes)))).code).toBe('INVALID_ENCODING');
  });

  it('rejects a missing column', async () => {
    const error = await rejection(parseText('name,city\nAcme Foods,Karachi\n'));
    expect(error.code).toBe('INVALID_HEADER');
    expect(error.getStatus()).toBe(400);
    expect(error.details).toEqual({ missing: ['country'] });
    expect((await rejection(parseText('city\nKarachi\n'))).details).toEqual({ missing: ['name', 'country'] });
    expect((await rejection(parseText(''))).code).toBe('INVALID_HEADER');
  });

  it('collects row problems', async () => {
    const error = await rejection(parseText('name,country,city,fei\nA,PK,,\nAcme Foods,Atlantis,,\nAcme Foods,PK,,12a\nGood Foods,PK,,\n'));
    expect(error.code).toBe('INVALID_ROWS');
    expect(error.getStatus()).toBe(400);
    expect(error.details).toEqual({
      count: 3,
      problems: [
        { row: 1, column: 'name', problem: 'too_short' },
        { row: 2, column: 'country', problem: 'unknown_country' },
        { row: 3, column: 'fei', problem: 'not_digits' },
      ],
    });
  });

  it('reports required cells and an FEI longer than ten digits', async () => {
    const error = await rejection(parseText('name,country,fei\n,,1\nAcme Foods,,12345678901\n'));
    expect(error.details).toEqual({
      count: 4,
      problems: [
        { row: 1, column: 'name', problem: 'required' },
        { row: 1, column: 'country', problem: 'required' },
        { row: 2, column: 'country', problem: 'required' },
        { row: 2, column: 'fei', problem: 'not_digits' },
      ],
    });
  });

  it('counts every problem but lists at most 20', async () => {
    const rows = Array.from({ length: 25 }, () => 'X,PK').join('\n');
    const error = await rejection(parseText(`name,country\n${rows}\n`));
    expect(error.code).toBe('INVALID_ROWS');
    const details = error.details as { count: number; problems: unknown[] };
    expect(details.count).toBe(25);
    expect(details.problems).toHaveLength(20);
  });

  it('rejects a file with a header and no data rows', async () => {
    for (const text of ['name,country\n', 'name,country', 'name,country\r\n\r\n,\r\n']) {
      const error = await rejection(parseText(text));
      expect(error.code).toBe('INVALID_ROWS');
      expect(error.details).toEqual({ count: 0, problems: [] });
    }
  });

  it('rejects text that is not valid CSV as invalid rows', async () => {
    expect((await rejection(parseText('name,country\n"Acme Foods,PK\n'))).code).toBe('INVALID_ROWS');
  });

  describe('limits', () => {
    const rowsOf = (count: number) => `name,country\n${Array.from({ length: count }, (_, i) => `Firm ${i + 1},PK`).join('\n')}\n`;

    it('accepts 5,000 rows', async () => {
      const rows = await parseText(rowsOf(BULK_LIMITS.maxRows), 4096);
      expect(rows).toHaveLength(5000);
      expect(rows[4999]).toEqual({ rowNr: 5000, name: 'Firm 5000', countryCode: 'PK', city: null, fei: null });
    });

    it('rejects row 5,001', async () => {
      const error = await rejection(parseText(rowsOf(BULK_LIMITS.maxRows + 1), 4096));
      expect(error.code).toBe('TOO_MANY_ROWS');
      expect(error.getStatus()).toBe(400);
    });

    it('accepts exactly 2 MB and rejects one byte more', async () => {
      const head = 'name,country\n';
      const pad = (extra: number) => `${head}${'a'.repeat(BULK_LIMITS.maxBytes - head.length - 3 + extra)},PK`;
      expect(Buffer.byteLength(pad(0))).toBe(BULK_LIMITS.maxBytes);
      await expect(parseText(pad(0), 65536)).resolves.toHaveLength(1);
      const error = await rejection(parseText(pad(1), 65536));
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(error.getStatus()).toBe(413);
    });

    it('stops reading as soon as the limit is passed', async () => {
      let pulled = 0;
      async function* endless(): AsyncGenerator<Buffer> {
        yield Buffer.from('name,country\n');
        for (let i = 0; i < 40; i++) {
          pulled++;
          yield Buffer.alloc(1024 * 1024, 'a');
        }
      }
      const error = await rejection(parseBulkCsv(endless()));
      expect(error.code).toBe('FILE_TOO_LARGE');
      expect(pulled).toBeLessThanOrEqual(3);
    });

    it('stops reading once row 5,001 is seen', async () => {
      let pulled = 0;
      const text = Buffer.from(`name,country\n${Array.from({ length: 6000 }, (_, i) => `Firm ${i + 1},PK`).join('\n')}\n`);
      async function* counting(): AsyncGenerator<Buffer> {
        for (let at = 0; at < text.length; at += 1024) {
          pulled++;
          yield text.subarray(at, at + 1024);
        }
      }
      expect((await rejection(parseBulkCsv(counting()))).code).toBe('TOO_MANY_ROWS');
      expect(pulled).toBeLessThan(Math.ceil(text.length / 1024));
    });
  });
});
