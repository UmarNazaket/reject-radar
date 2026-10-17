import { foldToAscii, isUsableName, normalizeName } from './normalize-name';

const primary = (raw: string) => normalizeName(raw).primary;

describe('normalizeName (spec §8.1)', () => {
  it.each([
    ['Al-Rehman Rice Mills (Pvt.) Ltd.', 'al rahman rice mills'],
    ['M/S. Haji Bashir Ahmad & Sons', 'haji bashir ahmad and sons'],
    ['CÔNG TY TNHH THỰC PHẨM ĐỨC PHÁT', 'thuc pham duc phat'],
    ['Cong Ty TNHH MTV Hai San Viet', 'hai san viet'],
    ['PT. Indofood Sukses Makmur Tbk', 'indofood sukses makmur'],
    ['Qingdao Haida Foodstuffs Co., Ltd.', 'qingdao haida foodstuffs'],
    ['Spice Exports Private Limited', 'spice exports'],
    ['ABC Foods Sdn. Bhd.', 'abc foods'],
    ['Olam Agro S.A. de C.V.', 'olam agro'],
    ['Hüsnü Gıda A.Ş.', 'husnu gida'],
    ['Al Noor Trading Est.', 'al noor trading'],
    ['Gulf Foods FZE', 'gulf foods'],
    ['Mohammed Intl Trdg Co', 'muhammad international trading'],
    ['Delta Exp. & Imp.', 'delta exports and imports'],
    ['Kamal Foods & Co.', 'kamal foods'],
    ['Messrs. Sharma Bros', 'sharma brothers'],
    ['Golden Trading Asia Ltd', 'golden trading asia'],
    ['123 Rice Mills', '123 rice mills'],
    ['The Ltd', 'ltd'],
    ['Ltd.', 'ltd'],
    ['PT Tbk', 'tbk'],
  ])('normalises %p to %p', (raw, expected) => {
    expect(primary(raw)).toBe(expected);
  });

  it('splits t/a and "trading as" names into aliases with the first part as primary', () => {
    expect(normalizeName('Sunrise Agro Pvt Ltd t/a Sunrise Spices')).toEqual({
      primary: 'sunrise agro',
      aliases: ['sunrise agro', 'sunrise spices'],
    });
    expect(normalizeName('Acme Exports trading as Acme Rice').aliases).toEqual(['acme exports', 'acme rice']);
  });

  it('splits d/b/a and aka markers', () => {
    expect(normalizeName('Acme Corp d/b/a Acme Foods').aliases).toEqual(['acme', 'acme foods']);
    expect(normalizeName('Acme Inc aka Acme Rice').aliases).toEqual(['acme', 'acme rice']);
  });

  it('removes duplicate aliases', () => {
    expect(normalizeName('Acme Ltd dba Acme Co').aliases).toEqual(['acme']);
  });

  it('returns an empty result for empty, missing or non-Latin input (review focus 1)', () => {
    expect(normalizeName('')).toEqual({ primary: '', aliases: [] });
    expect(normalizeName(null)).toEqual({ primary: '', aliases: [] });
    expect(normalizeName('   ')).toEqual({ primary: '', aliases: [] });
    expect(normalizeName('---')).toEqual({ primary: '', aliases: [] });
    expect(normalizeName('株式会社')).toEqual({ primary: '', aliases: [] });
    expect(normalizeName('شركة')).toEqual({ primary: '', aliases: [] });
    expect(normalizeName('मसाला')).toEqual({ primary: '', aliases: [] });
  });

  it('drops emoji and symbols but keeps the words', () => {
    expect(primary('Rice 🌾 Traders')).toBe('rice traders');
  });

  it('folds letters Unicode does not decompose', () => {
    expect(foldToAscii('Đà Nẵng Türkiye Straße Øresund Łódź')).toBe('da nang turkiye strasse oresund lodz');
  });
});

describe('isUsableName (review focus 1)', () => {
  it.each([
    ['', false],
    ['ltd', false],
    ['tbk', false],
    ['a s', false],
    ['the company', false],
    ['kamal foods', true],
    ['123 rice mills', true],
    ['al rahman rice mills', true],
    ['thanh cong', true],
    ['phan thanh', true],
    ['s m', true],
    ['cong ty', false],
    ['mot thanh vien', false],
    ['pvt ltd', false],
  ])('%p → %p', (nameNorm, expected) => {
    expect(isUsableName(nameNorm)).toBe(expected);
  });

  it('flags what normalizeName keeps from names made only of legal words', () => {
    for (const raw of ['The Ltd', 'M/S Ltd', 'PT Tbk', 'Co., Ltd.']) expect(isUsableName(normalizeName(raw).primary)).toBe(false);
  });
});
