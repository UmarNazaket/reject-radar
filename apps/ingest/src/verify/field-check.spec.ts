import { checkFields } from './field-check';

describe('checkFields', () => {
  it('compares names case- and whitespace-insensitively and ignores a byte-order mark', () => {
    expect(checkFields(['\uFEFFFEINumber', ' FirmName ', 'extra_col'], ['FEINumber', 'FirmName', 'RefusalDate'])).toEqual({
      missing: ['RefusalDate'],
      extra: ['extra_col'],
    });
  });
  it('reports nothing when the fields match', () => {
    expect(checkFields(['a', 'b'], ['b', 'a'])).toEqual({ missing: [], extra: [] });
  });
});
