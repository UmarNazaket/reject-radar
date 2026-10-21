import {
  addressSimilarity,
  normalizeAddress,
  normalizeAddressLine,
  normalizeCity,
  normalizeCountry,
  normalizePostalCode,
  stripLocationTail,
} from './normalize-address';
import { tokenSetJaroWinkler } from './similarity';

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
    ['Myanmar', 'MM'],
    ['Bosnia and Herzegovina', 'BA'],
    ['Trinidad and Tobago', 'TT'],
    ['Saint Lucia', 'LC'],
    ['St. Lucia', 'LC'],
    ['Cabo Verde', 'CV'],
    ['Macao', 'MO'],
    ['Brunei Darussalam', 'BN'],
    ['The Gambia', 'GM'],
    ['U.K.', 'GB'],
    ['Korea', null],
    ['IC', null],
    ['TA', null],
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
    ['Canton', 'canton'],
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

  describe('numbers (P3-D3)', () => {
    it('scores 0 when the numbers differ, however alike the rest is', () => {
      // Token-set Jaro-Winkler alone gave this pair 0.98.
      expect(addressSimilarity('plot 23 korangi industrial area', 'plot 25 korangi industrial area')).toBe(0);
    });

    it('scores 0 when only one side has a number', () => {
      // Token-set Jaro-Winkler alone gave this pair 0.82.
      expect(addressSimilarity('plot 23 korangi industrial area', 'korangi industrial area plot')).toBe(0);
      expect(addressSimilarity('korangi industrial area plot', 'plot 23 korangi industrial area')).toBe(0);
    });

    it('scores 1 for equal addresses that carry the same number', () => {
      const a = 'plot 23 korangi industrial area';
      expect(addressSimilarity(a, a)).toBe(1);
    });

    it('takes numbers as a set: order and repeats do not matter', () => {
      expect(addressSimilarity('plot 23 sector 7 korangi industrial area', 'sector 7 plot 23 korangi industrial area')).toBe(1);
      expect(addressSimilarity('plot 23 23 korangi industrial area', 'plot 23 korangi industrial area')).toBe(1);
    });

    it('treats a word with a digit in it as a number, so 23a is neither 23 nor 23b', () => {
      expect(addressSimilarity('plot 23a korangi industrial area', 'plot 23 korangi industrial area')).toBe(0);
      expect(addressSimilarity('plot 23a korangi industrial area', 'plot 23b korangi industrial area')).toBe(0);
    });

    it('still scores by Jaro-Winkler when the numbers agree', () => {
      const a = 'plot 23 korangi industrial area';
      const others = ['plot 23 korangy industrial area', 'plot 23 korangi industrial area karachi', 'plot 23 korangi industrial estate'];
      for (const b of others) expect(addressSimilarity(a, b)).toBe(tokenSetJaroWinkler(a, b));
      expect(addressSimilarity(a, 'plot 23 korangy industrial area')).toBeCloseTo(0.9871, 4);
      expect(addressSimilarity(a, 'plot 23 korangi industrial estate')).toBeLessThan(0.9);
    });

    it('leaves addresses without numbers exactly as they scored before', () => {
      for (const [a, b, before] of [
        ['main bazar road railway station', 'main bazaar road railway station', 0.9196],
        ['korangi industrial area plot', 'korangi industrial estate plot', 0.8548],
        ['korangi industrial area plot', 'gulberg main boulevard lahore', 0.6064],
        ['gulberg main boulevard lahore', 'gulberg main boulevard lahore cantt', 0.9002],
        ['industrial estate phase two', 'industrial estate phase three', 0.9576],
      ] as const) {
        expect(addressSimilarity(a, b)).toBeCloseTo(before, 4);
        expect(addressSimilarity(a, b)).toBe(tokenSetJaroWinkler(a, b));
      }
    });
  });
});

describe('stripLocationTail (P3-D3)', () => {
  const fuqing = { city: 'FUQING', region: 'Fujian', country: 'CHINA' };
  const zhanjiang = { city: 'Zhanjiang', region: 'Guangdong', country: 'CHINA' };

  it('cuts the city, region and country off the end of an Import Alert address', () => {
    expect(
      stripLocationTail('NO.5 Fulu Centre Road,Long Tian Economic , Development Area, , FUQING, Fujian CHINA', fuqing),
    ).toBe('NO.5 Fulu Centre Road,Long Tian Economic , Development Area');
    expect(stripLocationTail('Wuchuan , Zhanjiang, Guangdong CHINA', zhanjiang)).toBe('Wuchuan');
  });

  it('leaves a string without that tail unchanged', () => {
    const address = 'Plot 23 Korangi Industrial Area';
    expect(stripLocationTail(address, { city: 'Karachi', region: 'Sindh', country: 'Pakistan' })).toBe(address);
    expect(stripLocationTail('Plot 23, Korangi, ', { city: 'Karachi', country: 'Pakistan' })).toBe('Plot 23, Korangi, ');
    expect(stripLocationTail('', fuqing)).toBe('');
  });

  it('returns an empty string when nothing but the tail is there', () => {
    expect(stripLocationTail('Zhanjiang, Guangdong CHINA', zhanjiang)).toBe('');
    expect(stripLocationTail('CHINA', zhanjiang)).toBe('');
  });

  it('removes only the tail: the same words earlier in the address stay', () => {
    expect(stripLocationTail('Fuqing Road, Fuqing Economic Zone, FUQING, Fujian CHINA', fuqing)).toBe(
      'Fuqing Road, Fuqing Economic Zone',
    );
  });

  it('matches whole words only', () => {
    expect(stripLocationTail('Wuchuan, Zhanjiang', { city: 'jiang' })).toBe('Wuchuan, Zhanjiang');
    expect(stripLocationTail('Wuchuan, Zhanjiang', { city: 'zhan' })).toBe('Wuchuan, Zhanjiang');
    expect(stripLocationTail('Wuchuan, Xzhanjiang', { city: 'Zhanjiang' })).toBe('Wuchuan, Xzhanjiang');
    expect(stripLocationTail('12 Main Road, Newchina', { country: 'China' })).toBe('12 Main Road, Newchina');
  });

  it('compares folded text and returns the original spelling of what is left', () => {
    expect(stripLocationTail('Müller Straße 5, ZÜRICH, Switzerland', { city: 'Zurich', country: 'SWITZERLAND' })).toBe(
      'Müller Straße 5',
    );
    expect(stripLocationTail('Calle 5, Bogota, Colombia', { city: 'Bogotá', country: 'Colombia' })).toBe('Calle 5');
  });

  it('handles places of several words', () => {
    expect(
      stripLocationTail('Plot 5, Hi-Tech Zone, Ho Chi Minh City, Viet Nam', { city: 'Ho Chi Minh City', country: 'Viet Nam' }),
    ).toBe('Plot 5, Hi-Tech Zone');
  });

  it('takes ; as well as , and spaces for a separator', () => {
    expect(stripLocationTail('12 Main Road; Lahore ;; PAKISTAN ;', { city: 'Lahore', country: 'Pakistan' })).toBe('12 Main Road');
  });

  it('skips a part that is missing', () => {
    expect(stripLocationTail('Wuchuan, Zhanjiang, Guangdong CHINA', { country: 'China' })).toBe('Wuchuan, Zhanjiang, Guangdong');
    expect(stripLocationTail('Wuchuan, Zhanjiang', { city: 'Zhanjiang', region: null, country: undefined })).toBe('Wuchuan');
    expect(stripLocationTail('Wuchuan, Zhanjiang', { city: '', region: '  ' })).toBe('Wuchuan, Zhanjiang');
    expect(stripLocationTail('Wuchuan, Zhanjiang', {})).toBe('Wuchuan, Zhanjiang');
  });

  it('removes a region that has the same name as the city', () => {
    expect(stripLocationTail('Shinjuku 1-2-3, Tokyo, Tokyo JAPAN', { city: 'Tokyo', region: 'Tokyo', country: 'Japan' })).toBe(
      'Shinjuku 1-2-3',
    );
  });

  it('removes the parts in whatever order they stand', () => {
    expect(stripLocationTail('Wuchuan, Guangdong, Zhanjiang CHINA', zhanjiang)).toBe('Wuchuan');
  });
});
