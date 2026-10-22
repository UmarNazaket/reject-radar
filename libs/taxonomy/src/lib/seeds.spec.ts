import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ancestorIds,
  COMMODITIES,
  COMMODITY_RULES,
  COVERAGE_COMMODITY_RULES,
  COVERAGE_HAZARD_RULES,
  HAZARD_RULES,
  HAZARDS,
  OTHER_FOOD_ID,
  SEED_COMMODITY_RULES,
  SEED_HAZARD_RULES,
  UNCLASSIFIED_ID,
} from '../index';
import { normalizeRuleText } from './match';
import type { RuleSeed } from './rules';
import { taxonomyCoverageSql, taxonomySeedSql } from './seed-sql';

const migration = (file: string): string => readFileSync(path.join(__dirname, '../../../db/migrations', file), 'utf8');

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

  /**
   * 0002_taxonomy_seed.sql is frozen once applied: a database that already ran it never runs it again, so editing it
   * changes nothing there. If this test fails, a seed or a `SEED_*_RULES` rule no longer matches what databases hold.
   * Never edit or regenerate 0002. Either revert the change, or ship it as a NEW custom drizzle migration that turns the
   * 0002 data into the new data (inserts, updates, deletes) and run `taxonomy:remap` after deploying it, as
   * 0009_taxonomy_coverage did for `COVERAGE_*_RULES`.
   */
  it('matches the applied seed migration 0002_taxonomy_seed.sql byte for byte', () => {
    expect(sql).toBe(migration('0002_taxonomy_seed.sql'));
  });
});

describe('taxonomyCoverageSql', () => {
  const sql = taxonomyCoverageSql();

  it('inserts rules only', () => {
    expect(sql).toContain('insert into commodity_rule ');
    expect(sql).toContain('insert into hazard_rule ');
    expect(sql).not.toMatch(/insert into (commodity|hazard) \(/);
  });

  /** Frozen like 0002 once applied: a later rule change ships as a migration of its own. */
  it('matches the migration 0009_taxonomy_coverage.sql byte for byte', () => {
    expect(sql).toBe(migration('0009_taxonomy_coverage.sql'));
  });
});

describe('rules added after the seed', () => {
  const highest = (rules: readonly RuleSeed[]): number => Math.max(...rules.map((rule) => rule.priority));
  const seedHas = (seeds: readonly RuleSeed[], rule: RuleSeed): boolean =>
    seeds.some(
      (seed) =>
        (seed.source === rule.source || seed.source === '*') &&
        seed.field === rule.field &&
        seed.matchType === rule.matchType &&
        seed.pattern === rule.pattern,
    );

  it('come after the seeded rules, so databases hand them out in this order', () => {
    expect(COMMODITY_RULES).toEqual([...SEED_COMMODITY_RULES, ...COVERAGE_COMMODITY_RULES]);
    expect(HAZARD_RULES).toEqual([...SEED_HAZARD_RULES, ...COVERAGE_HAZARD_RULES]);
  });

  it('repeat no seeded pattern', () => {
    for (const rule of COVERAGE_COMMODITY_RULES) expect(seedHas(SEED_COMMODITY_RULES, rule)).toBe(false);
    for (const rule of COVERAGE_HAZARD_RULES) expect(seedHas(SEED_HAZARD_RULES, rule)).toBe(false);
  });

  /** A keyword can match a value a seeded rule matches too; ranking it last keeps every seeded classification. */
  it('rank every added keyword after every seeded rule', () => {
    const keywords = (rules: readonly RuleSeed[]) => rules.filter((rule) => rule.matchType === 'keyword');
    for (const rule of keywords(COVERAGE_COMMODITY_RULES)) expect(rule.priority).toBeGreaterThan(highest(SEED_COMMODITY_RULES));
    for (const rule of keywords(COVERAGE_HAZARD_RULES)) expect(rule.priority).toBeGreaterThan(highest(SEED_HAZARD_RULES));
  });
});
