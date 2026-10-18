import { ancestorIds, COMMODITIES, COMMODITY_RULES, HAZARD_RULES, HAZARDS, OTHER_FOOD_ID, UNCLASSIFIED_ID } from '../index';
import { normalizeRuleText } from './match';
import { taxonomySeedSql } from './seed-sql';

describe('seeded taxonomy', () => {
  it('has 38 commodities, 18 of them top level', () => {
    expect(COMMODITIES).toHaveLength(38);
    expect(COMMODITIES.filter((commodity) => commodity.parentId === null)).toHaveLength(18);
  });

  it('has unique ids and slugs', () => {
    expect(new Set(COMMODITIES.map((c) => c.id)).size).toBe(COMMODITIES.length);
    expect(new Set(COMMODITIES.map((c) => c.slug)).size).toBe(COMMODITIES.length);
    expect(new Set(HAZARDS.map((h) => h.id)).size).toBe(HAZARDS.length);
    expect(new Set(HAZARDS.map((h) => h.slug)).size).toBe(HAZARDS.length);
  });

  it('only points parents at existing top-level commodities', () => {
    const byId = new Map(COMMODITIES.map((c) => [c.id, c]));
    for (const commodity of COMMODITIES) {
      if (commodity.parentId === null) continue;
      expect(byId.get(commodity.parentId)?.parentId).toBeNull();
    }
  });

  it('expands HS ranges to every heading', () => {
    const find = (slug: string) => COMMODITIES.find((c) => c.slug === slug);
    expect(find('other-cereals')?.hsHeadings).toEqual([
      '1001', '1002', '1003', '1004', '1005', '1007', '1008', '1101', '1102', '1103', '1104', '1902',
    ]);
    expect(find('spices-herbs')?.hsHeadings).toEqual(['0904', '0905', '0906', '0907', '0908', '0909', '0910']);
    expect(find('chilli-paprika')?.hsHeadings).toEqual(['090421', '090422']);
  });

  it('has 21 hazards', () => {
    expect(HAZARDS).toHaveLength(21);
  });

  it('keeps the fallback ids pointing at real rows', () => {
    expect(COMMODITIES.find((c) => c.id === OTHER_FOOD_ID)?.slug).toBe('other-food');
    expect(HAZARDS.find((h) => h.id === UNCLASSIFIED_ID)?.slug).toBe('unclassified');
  });

  it('resolves every rule target to a slug', () => {
    const commoditySlugs = new Set(COMMODITIES.map((c) => c.slug));
    const hazardSlugs = new Set(HAZARDS.map((h) => h.slug));
    for (const rule of COMMODITY_RULES) expect(commoditySlugs).toContain(rule.target);
    for (const rule of HAZARD_RULES) expect(hazardSlugs).toContain(rule.target);
  });

  it('has no empty patterns and keeps text patterns normalised', () => {
    for (const rule of [...COMMODITY_RULES, ...HAZARD_RULES]) {
      expect(rule.pattern.length).toBeGreaterThan(0);
      if (rule.matchType !== 'code_prefix') expect(rule.pattern).toBe(normalizeRuleText(rule.pattern));
    }
  });

  it('computes ancestors', () => {
    expect(ancestorIds(202)).toEqual([200]);
    expect(ancestorIds(200)).toEqual([]);
    expect(ancestorIds(999999)).toEqual([]);
  });
});

describe('taxonomySeedSql', () => {
  const sql = taxonomySeedSql();

  it('inserts all four tables, separated by statement breakpoints', () => {
    for (const table of ['commodity', 'hazard', 'commodity_rule', 'hazard_rule']) {
      expect(sql).toContain(`insert into ${table} `);
    }
    expect(sql).toContain('--> statement-breakpoint');
  });

  it('is idempotent for the fixed-id tables only', () => {
    expect(sql.match(/on conflict do nothing/g)).toHaveLength(2);
  });
});
