import { countDuplicateKeys, extractRecords, summarizeRecords } from './summarize-records';

describe('extractRecords', () => {
  it('returns a top-level array', () => {
    expect(extractRecords([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
  it('follows a dot path to records nested under a key', () => {
    expect(extractRecords({ data: { items: [{ a: 1 }] } }, 'data.items')).toEqual([{ a: 1 }]);
  });
  it('explains a missing path', () => {
    expect(() => extractRecords({ data: {} }, 'data.items')).toThrow('JSON path "data.items" not found (stopped at "items")');
  });
  it('lists the keys when no array is found', () => {
    expect(() => extractRecords({ total: 3, content: [] })).toThrow('found keys: total, content');
  });
});

describe('summarizeRecords', () => {
  it('collects every field and measures fill rates case-insensitively', () => {
    const summary = summarizeRecords(
      [
        { FEINumber: 3004249948, FirmName: 'Acme', RefusalCharges: '118,508' },
        { FEINumber: null, FirmName: '', Hazards: [] },
        { FEINumber: 3001, FirmName: 'Beta', Hazards: [{ name: 'aflatoxin' }] },
        'not a record',
      ],
      ['feinumber', 'FirmName', 'Hazards'],
    );
    expect(summary.fields).toEqual(['FEINumber', 'FirmName', 'RefusalCharges', 'Hazards']);
    expect(summary.rows).toBe(3);
    expect(summary.fillRates).toEqual({ feinumber: 0.6667, firmname: 0.6667, hazards: 0.3333 });
  });
});

describe('countDuplicateKeys', () => {
  const records = [
    { ShipmentID: 'A', ProductCode: '1' },
    { ShipmentID: 'A', ProductCode: '2' },
    { ShipmentID: 'A', ProductCode: '1' },
  ];
  it('counts records whose key was already seen', () => {
    expect(countDuplicateKeys(records, ['ShipmentID'])).toBe(2);
    expect(countDuplicateKeys(records, ['shipmentid', 'ProductCode'])).toBe(1);
  });
});
