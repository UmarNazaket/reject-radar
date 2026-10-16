import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatReport, verifySource } from './verify-source';

describe('verifySource with a JSON file', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'verify-source-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads JSON that starts with a byte-order mark', async () => {
    const file = path.join(dir, 'bom.json');
    const bom = String.fromCharCode(0xfeff);
    await writeFile(file, bom + JSON.stringify({ items: [{ ref: 'A', hazard: 'aflatoxin' }, { ref: 'B', hazard: '' }] }), 'utf8');
    const result = await verifySource({ source: 'rasff', file, jsonPath: 'items', fillRate: ['hazard'], unique: ['ref'] });
    expect(result.rows).toBe(2);
    expect(result.fields).toEqual(['ref', 'hazard']);
    expect(result.fillRates).toEqual({ hazard: 0.5 });
    expect(result.duplicates).toBe(0);
  });

  it('names the file when the JSON is invalid', async () => {
    const file = path.join(dir, 'broken.json');
    await writeFile(file, '<html>not json</html>', 'utf8');
    await expect(verifySource({ source: 'rasff', file })).rejects.toThrow(`${file} is not valid JSON`);
  });
});

describe('verifySource with the FDA API', () => {
  const originalContact = process.env['INGEST_CONTACT_EMAIL'];

  beforeAll(() => {
    process.env['INGEST_CONTACT_EMAIL'] = 'test@example.com';
  });

  afterAll(() => {
    if (originalContact === undefined) delete process.env['INGEST_CONTACT_EMAIL'];
    else process.env['INGEST_CONTACT_EMAIL'] = originalContact;
  });

  it('verifies refusals without touching the network', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          statuscode: 400,
          message: 'Success.',
          resultcount: 2,
          totalrecordcount: 2,
          result: [
            { FEINumber: 1, FirmName: 'Acme', ShipmentID: 'S1' },
            { FEINumber: 2, FirmName: 'Beta', ShipmentID: 'S1' },
          ],
        }),
      )) as unknown as typeof fetch;

    const result = await verifySource({
      source: 'fda_refusals',
      from: '2026-07-01',
      to: '2026-07-31',
      unique: ['ShipmentID'],
      env: { FDA_API_USER: 'u', FDA_API_KEY: 'k' },
      fetchImpl: fakeFetch,
    });

    expect(result.rows).toBe(2);
    expect(result.total).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.missing).toContain('RefusalDate');
    expect(result.fillRates).toMatchObject({ feinumber: 1, firmname: 1 });
  });

  it('asks for FDA credentials when they are missing', async () => {
    await expect(verifySource({ source: 'fda_refusals', from: 'a', to: 'b', env: {} })).rejects.toThrow('FDA_API_USER');
  });
});

describe('formatReport', () => {
  it('renders a markdown section for the findings document', () => {
    const text = formatReport(
      {
        source: 'fda_refusals',
        origin: 'https://api.example/import_refusals',
        sha256: 'abc123',
        rows: 1234,
        total: 56789,
        fields: ['FEINumber', 'FirmName'],
        missing: ['ShipmentID'],
        extra: [],
        fillRates: { feinumber: 0.9821 },
        duplicates: 0,
        sample: '{"FEINumber":1}',
      },
      new Date('2026-10-20T10:00:00Z'),
    );
    expect(text).toContain('## fda_refusals — 2026-10-20T10:00:00.000Z');
    expect(text).toContain('- Rows read: 1,234 (the source reports 56,789 in total)');
    expect(text).toContain('- Missing expected fields: `ShipmentID`');
    expect(text).toContain('- Extra fields: none');
    expect(text).toContain('`feinumber` 98.21%');
    expect(text).toContain('- Duplicate keys: 0');
    expect(text).toContain('```json\n{"FEINumber":1}\n```');
  });
});
