import { countryFromFda, countryFromName } from './country';

describe('countryFromName', () => {
  it.each(['N/A', 'NA', 'none', 'Unknown', '--', ''])('treats %j as "not available"', (value) => {
    expect(countryFromName(value)).toBeNull();
  });
  it('treats null and undefined as not available', () => {
    expect(countryFromName(null)).toBeNull();
    expect(countryFromName(undefined)).toBeNull();
  });
  it('resolves names, including Namibia and Viet Nam', () => {
    expect(countryFromName('Namibia')).toBe('NA');
    expect(countryFromName('Viet Nam')).toBe('VN');
    expect(countryFromName('India')).toBe('IN');
  });
});

describe('countryFromFda', () => {
  it('reads NA as Namibia only when the name says so', () => {
    expect(countryFromFda('NA', 'Namibia')).toBe('NA');
    expect(countryFromFda('NA', '')).toBeNull();
    expect(countryFromFda('NA', null)).toBeNull();
    expect(countryFromFda('NA', 'N/A')).toBeNull();
  });
  it('uses any other code as given', () => {
    expect(countryFromFda('ID', 'Indonesia')).toBe('ID');
    expect(countryFromFda('id', null)).toBe('ID');
  });
  it('falls back to the name when there is no code', () => {
    expect(countryFromFda(null, 'Viet Nam')).toBe('VN');
    expect(countryFromFda('', '')).toBeNull();
  });
});
