import type { RuleMatchType, RuleSource } from '@rejectradar/contracts';
import { COMMODITIES } from './commodities';

/** A rule as seeded: `target` is the commodity or hazard slug, resolved to an id when written to the database. */
export interface RuleSeed {
  source: RuleSource;
  field: string;
  matchType: RuleMatchType;
  pattern: string;
  target: string;
  priority: number;
}

// Text patterns (`keyword`, `exact`) are stored already normalised (see `normalizeRuleText`); seeds.spec.ts enforces it.

const PRIORITY_EXACT = 10;
const PRIORITY_CHILD_KEYWORD = 10;
const PRIORITY_TOP_KEYWORD = 20;
const PRIORITY_CHILD_CODE = 40;
const PRIORITY_CATEGORY = 50;
const PRIORITY_INDUSTRY_CODE = 100;

/** Commodity keywords are matched against these free-text fields, one rule per keyword and field. */
const COMMODITY_TEXT_FIELDS = ['product_desc', 'product_name', 'subject'] as const;

/** Hazard keywords are matched against these free-text fields, one rule per keyword and field. */
const HAZARD_TEXT_FIELDS = ['charge', 'problem', 'title', 'hazard_name', 'subject', 'reason', 'test'] as const;

const COMMODITY_KEYWORDS: readonly (readonly [target: string, keywords: string])[] = [
  ['rice', 'rice, basmati'],
  ['other-cereals', 'wheat, maize, corn, flour, oats, barley, millet, sorghum, semolina, noodle, noodles, pasta'],
  ['chilli-paprika', 'chilli, chili, chillies, chilies, paprika, cayenne, capsicum'],
  ['turmeric', 'turmeric, curcuma'],
  ['cumin', 'cumin, jeera'],
  ['black-pepper', 'black pepper, peppercorn, peppercorns'],
  [
    'mixed-spices',
    'spice, spices, masala, curry powder, coriander, cardamom, clove, cloves, ginger, nutmeg, cinnamon, fenugreek, star anise',
  ],
  ['sesame', 'sesame, tahini, tahina'],
  ['groundnuts', 'peanut, peanuts, groundnut, groundnuts'],
  ['cashew', 'cashew, cashews'],
  ['pistachio', 'pistachio, pistachios'],
  ['almond', 'almond, almonds'],
  ['hazelnut', 'hazelnut, hazelnuts, filbert'],
  ['dates', 'dates, date palm'],
  ['raisins', 'raisin, raisins, sultana, sultanas'],
  ['apricots', 'apricot, apricots'],
  ['figs', 'fig, figs'],
  ['honey', 'honey'],
  ['shrimp', 'shrimp, shrimps, prawn, prawns'],
  ['molluscs', 'mussel, mussels, clam, clams, oyster, oysters, scallop, scallops, squid, octopus, cuttlefish'],
  ['fish', 'fish, tuna, salmon, mackerel, tilapia, pangasius, catfish, anchovy, anchovies, sardine, sardines, shark'],
  ['pulses', 'lentil, lentils, chickpea, chickpeas, dal, mung, moong'],
  ['tea-coffee-cocoa', 'tea, coffee, cocoa'],
  ['dairy', 'milk, cheese, yogurt, yoghurt, ghee, butter'],
  ['meat', 'beef, pork, chicken, poultry, mutton, lamb, sausage, sausages'],
  ['food-supplements', 'supplement, supplements, capsule, capsules, vitamin, vitamins'],
  ['beverages', 'juice, drink, drinks, beverage, beverages, wine, beer'],
  ['oils-fats', 'oil, oils'],
  ['confectionery-bakery', 'candy, confectionery, chocolate, biscuit, biscuits, cookie, cookies, cake, wafer, wafers, jelly'],
  ['animal-feed', 'feed, pet food, fodder'],
];

/** Category names (already normalised) to commodity slug; shared by RASFF and the UK notices. */
const PRODUCT_CATEGORIES: readonly (readonly [category: string, target: string])[] = [
  ['fruits and vegetables', 'fruit-vegetables'],
  ['herbs and spices', 'spices-herbs'],
  ['nuts nut products and seeds', 'nuts'],
  ['cereals and bakery products', 'cereals'],
  ['fish and fish products', 'fish'],
  ['crustaceans and products thereof', 'shrimp'],
  ['bivalve molluscs and products thereof', 'molluscs'],
  ['meat and meat products other than poultry', 'meat'],
  ['poultry meat and poultry meat products', 'meat'],
  ['milk and milk products', 'dairy'],
  ['fats and oils', 'oils-fats'],
  ['dietetic foods food supplements and fortified foods', 'food-supplements'],
  ['cocoa and cocoa preparations coffee and tea', 'tea-coffee-cocoa'],
  ['confectionery', 'confectionery-bakery'],
  ['non alcoholic beverages', 'beverages'],
  ['feed materials', 'animal-feed'],
  ['pet food', 'animal-feed'],
  ['honey and royal jelly', 'honey'],
];

/** FDA industry codes (also the Import Alert number prefix) to commodity slug. */
const INDUSTRY_CODES: readonly (readonly [codes: string, target: string])[] = [
  ['02, 04, 05', 'other-cereals'],
  ['03, 07, 33', 'confectionery-bakery'],
  ['09, 12, 13, 14', 'dairy'],
  ['16', 'fish-seafood'],
  ['17', 'meat'],
  ['20, 21, 22, 24, 25', 'fruit-vegetables'],
  ['23', 'nuts'],
  ['26', 'oils-fats'],
  ['28', 'spices-herbs'],
  ['29, 30, 32', 'beverages'],
  ['31, 34', 'tea-coffee-cocoa'],
  ['54', 'food-supplements'],
  ['69, 70, 71, 72', 'animal-feed'],
];

const HAZARD_KEYWORDS: readonly (readonly [target: string, keywords: string])[] = [
  ['ethylene-oxide', 'ethylene oxide, 2 chloroethanol, fumigant, phosphine'],
  [
    'pesticide-residues',
    'pesticide, pesticides, residue of, chlorpyrifos, carbendazim, acetamiprid, procymidone, hexaconazole, 2 phenylphenol, profenofos, tricyclazole, thiamethoxam, imidacloprid, phosalone, fenitrothion, flusilazole',
  ],
  ['aflatoxins', 'aflatoxin, aflatoxins'],
  ['ochratoxin-a', 'ochratoxin'],
  ['other-mycotoxins', 'mycotoxin, patulin, fumonisin, deoxynivalenol, zearalenone'],
  ['salmonella', 'salmonella'],
  ['listeria', 'listeria'],
  ['stec', 'e coli, stec, shiga'],
  [
    'other-pathogens',
    'clostridium, botulinum, bacillus cereus, staphylococcus, vibrio, norovirus, hepatitis, pathogen, micro organisms, microbiological, mould, mold, yeast',
  ],
  [
    'veterinary-drugs',
    'veterinary, animal drug, antibiotic, nitrofuran, nitrofurazone, sem, chloramphenicol, malachite green, enrofloxacin',
  ],
  ['heavy-metals', 'lead, mercury, cadmium, arsenic, heavy metal, heavy metals, metals'],
  ['other-contaminants', 'contaminant, contamination, poisonous, toxin, radionuclide, coumarin, sulphite, sulfite'],
  ['unauthorised-colours', 'sudan, colour, color, colours, colors, dye'],
  [
    'unauthorised-additives',
    'additive, additives, not permitted, sweetener, preservative, sodium benzoate, sorbic, food additives and flavourings',
  ],
  ['undeclared-allergens', 'allergen, allergens, undeclared'],
  ['labelling', 'label, labelling, labeling, misbranded, english, nutrition, ingredient, composition'],
  [
    'filth-decomposition',
    'filth, filthy, decomposed, decomposition, putrid, insanitary, rodent, insect, insects, histamine, unfit, diseased, pest infestation',
  ],
  ['foreign-bodies', 'foreign body, foreign object, glass, metal piece, plastic, embedded object'],
  [
    'registration-process',
    'registration, registered, not registered, lacf, acidified, low acid, scheduled process, process filing, fsvp',
  ],
  ['documents', 'document, documents, documentary, certificate, certificates, identity checks, documentary checks'],
];

/** RASFF hazard categories (normalised) to hazard slug. */
const RASFF_HAZARD_CATEGORIES: readonly (readonly [category: string, target: string])[] = [
  ['pesticide residues', 'pesticide-residues'],
  ['mycotoxins', 'other-mycotoxins'],
  ['pathogenic micro organisms', 'other-pathogens'],
  ['residues of veterinary medicinal products', 'veterinary-drugs'],
  ['metals', 'heavy-metals'],
  ['food additives and flavourings', 'unauthorised-additives'],
  ['allergens', 'undeclared-allergens'],
  ['labelling absent incomplete incorrect', 'labelling'],
  ['foreign bodies', 'foreign-bodies'],
  ['poor or insufficient controls', 'documents'],
  ['composition', 'labelling'],
];

/** UK hazard categories, including the typos that occur in the published data. */
const UK_HAZARD_CATEGORIES: readonly (readonly [categories: string, target: string])[] = [
  ['documentary checks, documentary, identity checks, docmentary checks, dcoumentary checks', 'documents'],
  ['pesticide residues, pesticice rsidues', 'pesticide-residues'],
  ['mycotoxins', 'other-mycotoxins'],
  ['metals and heavy metals', 'heavy-metals'],
  ['pathogenic micro organisms, microbiological, mycrobiological', 'other-pathogens'],
  ['food additives and flavourings', 'unauthorised-additives'],
  ['composition', 'labelling'],
  ['physical checks, physcial checks', 'filth-decomposition'],
];

/** FDA charge codes (normalised) to hazard slug. */
const FDA_CHARGE_CODES: readonly (readonly [codes: string, target: string])[] = [
  ['unfit4food, diseased', 'filth-decomposition'],
  ['imbed objt, holes', 'foreign-bodies'],
  ['leak swell, contam can, fsvp vio', 'registration-process'],
  ['poisonous, unsafe sub, bio toxin, radionuc, coumarin, excess sul', 'other-contaminants'],
  ['nutr def, omitted, substitute, reduced, non std', 'labelling'],
  ['forbidden, banned, nonnut sub', 'unauthorised-additives'],
];

const split = (list: string): string[] => list.split(',').map((item) => item.trim());

function keywordRules(
  table: readonly (readonly [target: string, keywords: string])[],
  fields: readonly string[],
  priorityOf: (target: string) => number,
): RuleSeed[] {
  return table.flatMap(([target, keywords]) =>
    split(keywords).flatMap((pattern) =>
      fields.map((field): RuleSeed => ({
        source: '*',
        field,
        matchType: 'keyword',
        pattern,
        target,
        priority: priorityOf(target),
      })),
    ),
  );
}

function exactRules(
  source: RuleSource,
  field: string,
  table: readonly (readonly [patterns: string, target: string])[],
  priority: number,
): RuleSeed[] {
  return table.flatMap(([patterns, target]) =>
    split(patterns).map((pattern): RuleSeed => ({ source, field, matchType: 'exact', pattern, target, priority })),
  );
}

const TOP_LEVEL_SLUGS = new Set(COMMODITIES.filter((c) => c.parentId === null).map((c) => c.slug));

/**
 * `uk_bn.commodity` HS prefixes: every heading in the commodity table. Children (priority 40) beat their parent
 * (50); within a priority the longer heading goes first, so `0713` (pulses) is tried before `07` (fresh produce).
 */
function hsPrefixRules(): RuleSeed[] {
  const rules = COMMODITIES.flatMap((commodity) =>
    commodity.hsHeadings.map((pattern): RuleSeed => ({
      source: 'uk_bn',
      field: 'commodity',
      matchType: 'code_prefix',
      pattern,
      target: commodity.slug,
      priority: commodity.parentId === null ? PRIORITY_CATEGORY : PRIORITY_CHILD_CODE,
    })),
  );
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.priority - b.rule.priority || b.rule.pattern.length - a.rule.pattern.length || a.index - b.index)
    .map(({ rule }) => rule);
}

export const COMMODITY_RULES: readonly RuleSeed[] = [
  ...keywordRules(COMMODITY_KEYWORDS, COMMODITY_TEXT_FIELDS, (target) =>
    TOP_LEVEL_SLUGS.has(target) ? PRIORITY_TOP_KEYWORD : PRIORITY_CHILD_KEYWORD,
  ),
  ...PRODUCT_CATEGORIES.map(([pattern, target]): RuleSeed => ({
    source: 'rasff',
    field: 'product_category',
    matchType: 'exact',
    pattern,
    target,
    priority: PRIORITY_CATEGORY,
  })),
  ...PRODUCT_CATEGORIES.map(([pattern, target]): RuleSeed => ({
    source: 'uk_bn',
    field: 'product_category',
    matchType: 'exact',
    pattern,
    target,
    priority: PRIORITY_CATEGORY,
  })),
  ...hsPrefixRules(),
  ...exactRules('fda_refusal', 'industry_code', INDUSTRY_CODES, PRIORITY_INDUSTRY_CODE),
  ...exactRules('import_alert', 'industry_code', INDUSTRY_CODES, PRIORITY_INDUSTRY_CODE),
];

export const HAZARD_RULES: readonly RuleSeed[] = [
  ...exactRules('rasff', 'hazard_category', RASFF_HAZARD_CATEGORIES, PRIORITY_EXACT),
  ...exactRules('uk_bn', 'hazard_category', UK_HAZARD_CATEGORIES, PRIORITY_EXACT),
  ...exactRules('fda_charge_code', 'code', FDA_CHARGE_CODES, PRIORITY_EXACT),
  ...keywordRules(HAZARD_KEYWORDS, HAZARD_TEXT_FIELDS, () => PRIORITY_TOP_KEYWORD),
];
