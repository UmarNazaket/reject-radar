import {
  addressSimilarity,
  normalizeAddress,
  normalizeAddressLine,
  normalizeCity,
  normalizeCountry,
  normalizePostalCode,
} from './normalize-address';

describe('normalizeAddress (spec §8.1)', () => {
  it('normalises every field', () => {
    expect(
      normalizeAddress({
        line1: 'Plot No. 12, Sector 7-A',
        line2: 'Korangi Ind. Area',
        city: 'Karāchi',
        region: 'Sindh',
        postalCode: '74900',
        country: 'Pakistan',
      }),
    ).toEqual({
      countryCode: 'PK',
      region: 'sindh',
      city: 'karachi',
      postalCode: '74900',
      addressNorm: 'plot 12 sector 7 a korangi industrial area',
    });
  });

  it('returns null when nothing usable is present', () => {
    expect(normalizeAddress({ line1: '', city: '  ', postalCode: 'n/a', country: 'Unknown' })).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
  });
});

describe('normalizeCountry (review focus 2)', () => {
  it.each([
    ['Pakistan', 'PK'],
    ['PAKISTAN', 'PK'],
    ['pk', 'PK'],
    ['India', 'IN'],
    ['Bangladesh', 'BD'],
    ['Sri Lanka', 'LK'],
    ['Kenya', 'KE'],
    ['Egypt', 'EG'],
    ['Viet Nam', 'VN'],
    ['Vietnam', 'VN'],
    ['Türkiye', 'TR'],
    ['Turkey', 'TR'],
    ['Korea, Republic of', 'KR'],
    ['Hong Kong SAR', 'HK'],
    ["Côte d'Ivoire", 'CI'],
    ['USA', 'US'],
    ['United States', 'US'],
    ['UK', 'GB'],
    ['United Kingdom', 'GB'],
    ['France', 'FR'],
    ['Russia', 'RU'],
    ['Serbia', 'RS'],
    ['Burkina Faso', 'BF'],
    ['Timor-Leste', 'TL'],
    ['Congo - Kinshasa', 'CD'],
    ['SU', null],
    ['FX', null],
    ['Unknown', null],
    ['XX', null],
    ['European Union', null],
    ['', null],
    [null, null],
  ])('maps %p to %p', (value, expected) => {
    expect(normalizeCountry(value)).toBe(expected);
  });
});

describe('normalizeCity', () => {
  it.each([
    ['Bombay', 'mumbai'],
    ['HCMC', 'ho chi minh city'],
    ['TP. Hồ Chí Minh', 'ho chi minh city'],
    ['Dacca', 'dhaka'],
    ['Karachi', 'karachi'],
    ['São Paulo', 'sao paulo'],
    ['', null],
    [null, null],
  ])('maps %p to %p', (value, expected) => {
    expect(normalizeCity(value)).toBe(expected);
  });
});

describe('normalizePostalCode', () => {
  it.each([
    ['74900', '74900'],
    ['K1A 0B1', 'K1A0B1'],
    ['110 001', '110001'],
    ['n/a', null],
    ['None', null],
    ['00000', null],
    ['12', null],
    [null, null],
  ])('maps %p to %p', (value, expected) => {
    expect(normalizePostalCode(value)).toBe(expected);
  });
});

describe('normalizeAddressLine / addressSimilarity', () => {
  it('unifies abbreviations and drops filler words', () => {
    expect(normalizeAddressLine('Plot No. 12, Main Rd.', 'Near Opp. Bus Stand')).toBe('plot 12 main road bus stand');
    expect(normalizeAddressLine(null, '  ')).toBeNull();
  });

  it('scores identical addresses 1 and needs at least 3 words on each side', () => {
    const a = 'plot 12 sector 7 a korangi industrial area';
    expect(addressSimilarity(a, a)).toBe(1);
    expect(addressSimilarity('main road', 'main road')).toBe(0);
    expect(addressSimilarity(null, a)).toBe(0);
  });

  it('scores unrelated addresses below the 0.90 match line', () => {
    expect(addressSimilarity('plot 12 sector 7 a korangi industrial area', '5 gulberg main boulevard lahore')).toBeLessThan(0.9);
  });
});
