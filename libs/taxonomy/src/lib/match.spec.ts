import { COMMODITIES } from './commodities';
import { HAZARDS } from './hazards';
import { buildRuleSet, classifyCommodity, classifyHazards, normalizeRuleText, type TaxonomyRule } from './match';
import { COMMODITY_RULES, HAZARD_RULES, type RuleSeed } from './rules';

/** The seeded rules with ids in seed order, as the database would hand them out. */
function toRules(seeds: readonly RuleSeed[], targets: readonly { id: number; slug: string }[]): TaxonomyRule[] {
  const bySlug = new Map(targets.map((target) => [target.slug, target.id]));
  return seeds.map((seed, index) => ({
    id: index + 1,
    source: seed.source,
    field: seed.field,
    matchType: seed.matchType,
    pattern: seed.pattern,
    targetId: bySlug.get(seed.target) as number,
    priority: seed.priority,
  }));
}

const rules = buildRuleSet(toRules(COMMODITY_RULES, COMMODITIES), toRules(HAZARD_RULES, HAZARDS));

describe('normalizeRuleText', () => {
  it('folds case, ampersands and punctuation', () => {
    expect(normalizeRuleText('Fruits & Vegetables ')).toBe('fruits and vegetables');
    expect(normalizeRuleText('Chemical contamination (inc. environmental & industrial')).toBe(
      'chemical contamination inc environmental and industrial',
    );
  });

  it('folds accents to ASCII', () => {
    expect(normalizeRuleText('Jalapeño')).toBe('jalapeno');
  });
});

describe('classifyCommodity', () => {
  it('matches whole words only', () => {
    expect(classifyCommodity(rules, 'fda_refusal', { product_desc: 'Rice Bran Oil' })).toBe(101);
    expect(classifyCommodity(rules, 'fda_refusal', { product_desc: 'Price list' })).toBe(1800);
  });

  it('lets a child keyword beat the industry code', () => {
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '28', product_desc: 'TURMERIC POWDER' })).toBe(202);
  });

  it('falls back to the industry code when no keyword matches', () => {
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '16', product_desc: 'FROZEN PRODUCT' })).toBe(1000);
  });

  it('trims industry codes', () => {
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '28 ' })).toBe(200);
  });

  it('falls back to other food', () => {
    expect(classifyCommodity(rules, 'fda_refusal', { product_desc: 'mystery item' })).toBe(1800);
    expect(classifyCommodity(rules, 'fda_refusal', {})).toBe(1800);
  });

  it('classifies UK commodity codes by HS prefix', () => {
    expect(classifyCommodity(rules, 'uk_bn', { commodity: '0909 3100' })).toBe(203);
    expect(classifyCommodity(rules, 'uk_bn', { commodity: '12024200' })).toBe(302);
  });

  it('prefers the longer HS heading over a broader one', () => {
    expect(classifyCommodity(rules, 'uk_bn', { commodity: '0713 10' })).toBe(700);
    expect(classifyCommodity(rules, 'uk_bn', { commodity: '1806 31' })).toBe(1300);
  });

  it('matches RASFF product categories exactly and UK ones after normalising', () => {
    expect(classifyCommodity(rules, 'rasff', { product_category: 'herbs and spices' })).toBe(200);
    expect(classifyCommodity(rules, 'uk_bn', { product_category: 'Fruits & vegetables' })).toBe(600);
  });

  it('ignores rules for other sources and absent fields', () => {
    expect(classifyCommodity(rules, 'rasff', { industry_code: '28' })).toBe(1800);
    expect(classifyCommodity(rules, 'rasff', { product_category: null })).toBe(1800);
  });
});

describe('classifyHazards', () => {
  it('matches each value on its own and returns the sorted union', () => {
    expect(
      classifyHazards(rules, 'rasff', { hazard_name: ['Salmonella - pathogenic micro-organisms', 'aflatoxin B1'] }),
    ).toEqual([300, 400]);
  });

  it('falls back to unclassified', () => {
    expect(classifyHazards(rules, 'rasff', { hazard_name: ['something new'] })).toEqual([1200]);
    expect(classifyHazards(rules, 'rasff', {})).toEqual([1200]);
  });

  it('still classifies the UK typo forms', () => {
    expect(classifyHazards(rules, 'uk_bn', { hazard_category: ['Docmentary checks'] })).toEqual([1100]);
  });

  it('classifies FDA charge codes', () => {
    expect(classifyHazards(rules, 'fda_charge_code', { code: ['UNFIT4FOOD', 'LEAK/SWELL'] })).toEqual([900, 1000]);
  });

  it('skips blank values', () => {
    expect(classifyHazards(rules, 'rasff', { hazard_name: [null, undefined, '  '] })).toEqual([1200]);
  });
});
