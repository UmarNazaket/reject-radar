import { isDistinctiveName } from './distinctive';

const freq = (table: Record<string, number>) => (token: string) => table[token] ?? 0;

describe('isDistinctiveName (spec §8.2; frequencies are counted within one country)', () => {
  it('is false when every token is common', () => {
    expect(isDistinctiveName('al rahman rice mills', freq({ al: 900, rahman: 300, rice: 2000, mills: 1500 }))).toBe(false);
  });
  it('is true when the rarest token appears in fewer than 50 names', () => {
    expect(isDistinctiveName('qingdao haida foodstuffs', freq({ qingdao: 400, haida: 3, foodstuffs: 900 }))).toBe(true);
  });
  it('treats exactly 50 as not distinctive', () => {
    expect(isDistinctiveName('mid foods', freq({ mid: 50, foods: 9000 }))).toBe(false);
  });
  it('is false for an empty name', () => {
    expect(isDistinctiveName('', freq({}))).toBe(false);
  });
  it('is false for a name made only of legal words', () => {
    expect(isDistinctiveName('ltd', freq({ ltd: 0 }))).toBe(false);
  });
});
