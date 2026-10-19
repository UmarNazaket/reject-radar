import { canonical } from './identity';

describe('canonical (frozen Import Alert identity text)', () => {
  it('strips accents, upper-cases and collapses every run of non-alphanumerics to one space', () => {
    expect(canonical('  Société Générale, S.A. ')).toBe('SOCIETE GENERALE S A');
    expect(canonical('Bazaar Kandhar--yellow\tCarvansera / No. 9')).toBe('BAZAAR KANDHAR YELLOW CARVANSERA NO 9');
    expect(canonical('KOREA, REPUBLIC OF (SOUTH)')).toBe('KOREA REPUBLIC OF SOUTH');
    expect(canonical('Ｆｕｌｌｗｉｄｔｈ Ｃｏ．')).toBe('FULLWIDTH CO');
    expect(canonical('')).toBe('');
    expect(canonical(' ,.; ')).toBe('');
  });

  it('keeps letters and digits of other scripts', () => {
    expect(canonical('北京 食品, 有限公司 2')).toBe('北京 食品 有限公司 2');
  });
});
