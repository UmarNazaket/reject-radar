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

describe('rules added by 0009_taxonomy_coverage', () => {
  it.each([
    ['Unauthorized novel food in food supplement from Poland', 801],
    ['the presence of metallic foreign bodies in flour', 901],
    ['Fish bone fragments in cat feed', 901],
    ['Ergot on Triticale from Germany', 302],
    ['illegal import of milk, eggs, bovine and poultry meat in composite products from Perù', 1100],
    ['Non-conforming consignment of bovine meat not presented for official control at the BCP', 1100],
    ['Ruptura de la cadena de frío en sardinas congeladas de Marruecos/ Poor temperature control in frozen sardines', 1100],
    ['Unauthorised substance ETO in peppers from Uganda', 200],
    ['Formetanate in fresh peppers from Türkiye', 100],
    ['Unauthorised substance tolfenpyrad in black tea from India', 100],
    ['Aflatoxine B1 in groundnuts from Argentina', 300],
    ['Ochratoxine A in coffee from Kenya', 301],
    ['S. TYPHIMURIUM IN CHICKEN LIVERS', 400],
    ['L. monocytogenes detected in smoked mackerel pieces from Latvia', 401],
    ['Shigatoxin-producing Escherichia coli in lamb meat from New Zealand', 402],
    ['Parasitic infestation (anisakis) in frozen salmon from the USA', 403],
    ['Nitrofurans (AOZ) in shrimps from Vietnam', 500],
    ['Nickel in asparagus from Spain', 600],
    ['Pyrrolizidine alkaloids in dried oregano from Turkey', 601],
    ['Titanium dioxide (E 171) in food supplements from Cyprus', 700],
    ['Too high content of benzoic acid in soft drink from United States', 701],
    ['Gluten in gluten free kebab from Germany', 800],
    ['unauthorised substance hordenine in a food supplement from USA', 801],
    ['Presence of mouse droppings in dates from Israel', 900],
  ])('classifies the RASFF subject "%s" as hazard %i', (subject, hazard) => {
    expect(classifyHazards(rules, 'rasff', { subject: [subject] })).toEqual([hazard]);
  });

  it.each([
    ['test', 'Fruit and vegetable residue screen', 100],
    ['reason', 'Difenoconazole', 100],
    ['test', 'Hydrocyanic acid detected in excess of level permitted', 601],
    ['test', 'Iodine detected in excess of level permitted', 601],
    ['test', 'Prohibited plant - Areca catechu (betel nut)', 601],
    ['test', 'Standard plate count', 403],
    ['test', 'Escherichia coli detected in excess of levels permitted', 402],
    ['test', 'Caffeine in excess of levels permitted', 701],
    ['test', 'Fluoroquinolones', 500],
  ])('classifies the Australian %s "%s" as hazard %i', (field, value, hazard) => {
    expect(classifyHazards(rules, 'au_ifis', { [field]: [value] })).toEqual([hazard]);
  });

  it('keeps an 0002 hazard keyword ahead of an added one in the same value', () => {
    expect(classifyHazards(rules, 'rasff', { subject: ['Aflatoxins and foreign bodies in pistachios from Iran'] })).toEqual([300]);
  });

  it('adds hazard keywords for RASFF subjects and Australian tests and reasons only', () => {
    expect(classifyHazards(rules, 'rasff', { hazard_name: ['formetanate'] })).toEqual([1200]);
    expect(classifyHazards(rules, 'uk_bn', { reason: ['Hydrocyanic acid'] })).toEqual([1200]);
  });

  it.each([
    ['rasff', 'alcoholic beverages', 1400],
    ['rasff', 'natural mineral waters', 1400],
    ['rasff', 'cephalopods and products thereof', 1003],
    ['rasff', 'compound feeds', 1700],
    ['uk_bn', 'Gastropods', 1003],
  ] as const)('classifies the %s product category "%s" as commodity %i', (source, category, commodity) => {
    expect(classifyCommodity(rules, source, { product_category: category })).toBe(commodity);
  });

  it('classifies FDA industry codes written without the leading zero', () => {
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '3', product_desc: 'BAGEL BREAD/ROLLS' })).toBe(1300);
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '7', product_desc: 'POTATO CHIPS, FRIED SNACK FOODS' })).toBe(1300);
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '4', product_desc: 'SPAGHETTI' })).toBe(102);
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '9', product_desc: 'EGG NOG' })).toBe(1200);
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '3', product_desc: 'TURMERIC POWDER' })).toBe(202);
  });

  it.each([
    ['Tapioca chips', 1300],
    ['Cream crackers', 1300],
    ['Fresh lychee', 600],
    ['Dried kelp', 600],
    ['Dried longan', 500],
    ['Betel nut', 400],
    ['Breakfast cereal', 100],
    ['Black eyed beans', 700],
    ['Barramundi fillets', 1002],
    ['Frozen soft shell crab', 1000],
    ['Duck liver', 1100],
    ['Vintage cheddar red lion red wax', 1200],
    ['Margarine', 1500],
  ])('classifies the Australian product "%s" as commodity %i', (product, commodity) => {
    expect(classifyCommodity(rules, 'au_ifis', { product_desc: product })).toBe(commodity);
  });

  it('classifies a RASFF subject whose product category names no commodity', () => {
    expect(classifyCommodity(rules, 'rasff', { product_category: 'other food product / mixed', subject: 'Aflatoxins in walnuts from Ukraine' })).toBe(400);
  });

  it('ranks added commodity keywords after every 0002 rule', () => {
    expect(classifyCommodity(rules, 'au_ifis', { product_desc: 'Prawn crackers' })).toBe(1001);
    expect(classifyCommodity(rules, 'rasff', { product_category: 'herbs and spices', subject: 'Pyrrolizidine alkaloids in dried oregano from Turkey' })).toBe(200);
  });

  it('adds commodity keywords for RASFF subjects and Australian products only', () => {
    expect(classifyCommodity(rules, 'fda_refusal', { industry_code: '37', product_desc: 'BANANA SAUCE' })).toBe(1800);
  });
});
