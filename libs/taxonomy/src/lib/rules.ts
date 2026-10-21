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

/** The commodity rules migration 0002_taxonomy_seed inserted. Frozen: a change ships as a new migration (see README). */
export const SEED_COMMODITY_RULES: readonly RuleSeed[] = [
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

/** The hazard rules migration 0002_taxonomy_seed inserted. Frozen: a change ships as a new migration (see README). */
export const SEED_HAZARD_RULES: readonly RuleSeed[] = [
  ...exactRules('rasff', 'hazard_category', RASFF_HAZARD_CATEGORIES, PRIORITY_EXACT),
  ...exactRules('uk_bn', 'hazard_category', UK_HAZARD_CATEGORIES, PRIORITY_EXACT),
  ...exactRules('fda_charge_code', 'code', FDA_CHARGE_CODES, PRIORITY_EXACT),
  ...keywordRules(HAZARD_KEYWORDS, HAZARD_TEXT_FIELDS, () => PRIORITY_TOP_KEYWORD),
];

// ── Added by migration 0009_taxonomy_coverage ───────────────────────────────────────────────────────────────────────
// Taken from the most frequent words of the RASFF subjects, Australian tests, reasons and products and FDA industry
// codes that the seed left unclassified or "Other food". Every rule either reads a value no seeded rule matches (a
// category or code the seed lacks) or ranks after every seeded rule, so no seeded classification changes. A record
// with several values (an Australian test and reason) can still gain a hazard from a value that matched nothing before.

/** Named substances, organisms and checks; they rank before the generic phrases below. */
const PRIORITY_ADDED_HAZARD = 30;
/** Generic phrases (`unauthorised substance`, `mrl`, `metal`) that only decide when nothing named matched. */
const PRIORITY_ADDED_HAZARD_PHRASE = 40;
/** After the FDA industry codes (100), the last seeded commodity rules. */
const PRIORITY_ADDED_COMMODITY = 150;

/** RASFF subjects (read only for notifications without hazard details) and the Australian tests and reasons. */
const ADDED_HAZARD_FIELDS: readonly (readonly [source: RuleSource, field: string])[] = [
  ['rasff', 'subject'],
  ['au_ifis', 'test'],
  ['au_ifis', 'reason'],
];

/** RASFF subjects and Australian products; FDA refusals keep falling back to their industry code. */
const ADDED_COMMODITY_FIELDS: readonly (readonly [source: RuleSource, field: string])[] = [
  ['rasff', 'subject'],
  ['au_ifis', 'product_desc'],
];

// Within a priority the first listed target wins, so the order matters where one value names two things: pesticide
// names before the "unauthorised" checks, parasites and moulds before infestation, snacks before produce (cassava
// chips), fish before meat (crab meat).

const ADDED_HAZARD_KEYWORDS: readonly (readonly [target: string, keywords: string])[] = [
  [
    'ethylene-oxide',
    'ethyleneoxide, eto, ethylene oxyde, ethylenen oxide, ossido di etilene, oxido de etileno, oxyde d ethylene, ethylenoxid, propylene oxide, bromide',
  ],
  [
    'pesticide-residues',
    'residue screen, pesticid, pesticidas, pesticidi, pestizide, plaguicidas, formetanate, prochloraz, dimethoate, chlorate, chlorates, cypermethrin, acephate, acephat, flonicamid, difenoconazole, anthraquinone, imazalil, methamidophos, pyridaben, propiconazole, oxamyl, cyhalothrin, cyhalothrine, buprofezin, chlorfenapyr, omethoate, omethoat, fosthiazate, permethrin, clothianidin, tebuconazole, iprodione, chlorothalonil, chlorthalonil, ethephon, methomyl, monocrotophos, carbofuran, fenvalerate, propargite, fipronil, phosmet, metalaxyl, dinotefuran, tebufenpyrad, chlorpropham, linuron, bifenthrin, indoxacarb, pyraclostrobin, pirimiphos, dithiocarbamate, dithiocarbamates, dimethomorph, azoxystrobin, haloxyfop, spirotetramat, thiabendazole, abamectin, chlormequat, heptachlor, glufosinate, deltamethrin, fenbutatin oxide, fenamiphos, fenpropathrin, ethion, paclobutrazol, etoxazole, cyfluthrin, carbaryl, cyprodinil, triadimenol, penconazole, propamocarb, malathion, folpet, captan, fluazifop, thiophanate methyl, hexythiazox, pymetrozine, flutriafol, cyflumetofen, pyrimethanil, famoxadone, triazophos, lufenuron, spirodiclofen, biphenyl, diflubenzuron, pyriproxyfen, phenthoate, paraquat, forchlorfenuron, sulfoxaflor, glyphosate, thiacloprid, dichlorvos, fluvalinate, acrinathrin, fenthion, bifenazate, propyzamide, propoxur, fenamidone, methiocarb, fludioxonil, triadimefon, myclobutanil, fluopyram, diazinon, phosphonic acid, cyromazine, spinosad, mcpa, fenpyroximate, boscalid, diniconazole, isoprothiolane, methoxyfenozide, acetochlor, cyproconazole, fosetyl, aclonifen, phoxim, penthiopyrad, quinalphos, triclopyr, ethoprophos, tebufenozide, diuron, phorate, spiroxamine, picoxystrobin, proquinazid, azinphos methyl, cadusafos, spinetoram, cyantraniliprole, thiodicarb, fluazinam, simazine, meptyldinocap, flubendiamide, bromoxynil, diquat, aldicarb, prothioconazole, fluxapyroxad, diafenthiuron, tolfenpyrad, nitenpyram, quintozene, quintozen, prometryn, isoprocarb, carboxin, tetramethrin, butachlor, matrine, matrin, oxymatrine, oxymatrin, didecyldimethylammonium chloride, ddac, chlorpyriphos, chlorpirifos, clorpirifos, tricyclazol, thiametoxam',
  ],
  ['aflatoxins', 'aflatoxine, aflatoxines, aflatoxina, aflatoxinas, aflatossina, aflatossine'],
  ['ochratoxin-a', 'ochratoxins, ochratoxine, ocratoxina, ocratossina, ocratossine, ota'],
  ['other-mycotoxins', 'ergot, sclerotia, citrinin, alternaria, tenuazonic acid, t 2, ht 2, t2, ht2, mycotoxines, micotossine'],
  ['salmonella', 'salmonelles, salmonelle, salmonellen, salmonela, enteritidis, typhimurium, infantis'],
  ['listeria', 'monocytogenes'],
  ['stec', 'escherichia coli, shigatoxin, verotoxin, stx'],
  [
    'other-pathogens',
    'anisakis, fasciola, trichinella, toxoplasma, parasites, parasite, parasitic, moulds, molds, mouldy, yeasts, cereulide, standard plate count, plate count, enterobacteriaceae, coliforms, cronobacter, campylobacter, yersinia, shigella, pseudomonas, bacteria, bacterial, mesophilic, aerobic, keimgehalt, virus',
  ],
  [
    'veterinary-drugs',
    'oxytetracycline, chlortetracycline, doxycycline, tetracycline, azithromycin, ciprofloxacin, ofloxacin, fluoroquinolones, streptomycin, sulfadiazine, sulfadimethoxine, sulfamethazine, sulfonamides, sulphonamides, trimethoprim, nitrofurans, furazolidone, semicarbazide, leucomalachite green, crystal violet, florfenicol, ivermectin, antibiotics, coccidiostat, coccidiostats, toltrazuril, salinomycin, nicarbazin, lasalocid, monensin, narasin, diclofenac',
  ],
  ['heavy-metals', 'nickel, aluminium, aluminum'],
  [
    'other-contaminants',
    'pyrrolizidine alkaloids, tropane alkaloids, quinolizidine alkaloids, opium alkaloids, morphine, atropine, scopolamine, asarone, hydrocyanic acid, hydrogen cyanide, cyanide, iodine, prohibited plant, polycyclic aromatic hydrocarbons, pah, pahs, pah4, benzo a pyrene, mineral oil, mosh, moah, glycidyl, 3 mcpd, dioxin, dioxins, pcb, pcbs, pfos, pfoa, pfna, pfas, acrylamide, erucic acid, perchlorate, nitrate, nitrates, melamine, bamboo, formaldehyde, primary aromatic amines, migration, lipophilic toxins, okadaic acid, domoic acid, dsp, dsps, psp, saxitoxin, pinnatoxins, biotoxins, ciguatoxin, tetrodotoxin, thc, tetrahydrocannabinol, ruminant, sulphites, sulfites, sulphur dioxide, sulfur dioxide',
  ],
  [
    'unauthorised-colours',
    'e 171, e171, titanium dioxide, e 110, e110, sunset yellow, e 102, e102, tartrazine, e 124, e124, ponceau, e 127, e127, erythrosine, e 129, e129, allura red, e 160b, e160b, annatto, carmoisine, rhodamine, reactive red, canthaxanthin, colorant, colourant, colorants, colourants, colouring, coloring, colourings, colorings, pigment, pigments',
  ],
  [
    'unauthorised-additives',
    'ascorbic acid, e 300, benzoic acid, e 210, e 211, potassium sorbate, e 202, e202, e 425, e425, konjac, e 440, e440, acesulfame, sweeteners, maltitol, e 965, e965, e 950, e950, e 955, e955, cyclamate, saccharin, steviol glycosides, e 235, e235, natamycin, e 905, e905, microcrystalline wax, paraffin, glutamate, flavouring, flavourings, flavoring, flavorings, carbon monoxide, caffeine, nitrite, nitrites, ethoxyquin, phosphates, polyphosphates',
  ],
  ['undeclared-allergens', 'milk protein, peanut protein'],
  [
    'labelling',
    'novel food, novel foods, nuevo alimento, nowa zywnosc, cbd, cannabidiol, cannabinoids, thcp, hhc, sildenafil, tadalafil, yohimbine, yohimbe, synephrine, rauwolfia, huperzine, 5 htp, griffonia, grifonia, tongkat ali, eurycoma, epimedium, mitragyna, kratom, muscimol, ashwagandha, dmaa, dimethylamylamine, egcg, green tea extract, mucuna, beta alanine, aloe emodin, genetically modified, gmo, trans fatty acids, ragweed, ambrosia, porcine dna, ionizing radiation, ionising radiation, irradiated, irradiation, use by date, best before, expiry date, health claims',
  ],
  [
    'filth-decomposition',
    'infested, infestation, pests, rodents, droppings, excrement, flies, maggots, moths, larvae, mites, weevils, beetles, cockroaches, rotten, spoiled, spoilage, putrefaction, deterioration, organoleptic, bad smell, bad smelling, rancid, rancidity',
  ],
  [
    'foreign-bodies',
    'foreign bodies, foreign objects, foreign matter, metallic, metal fragment, metal fragments, metal particles, metal pieces, metal shavings, shavings, bone fragments, bones, stone, stones, pebbles, suffocation, choking',
  ],
  [
    'documents',
    'official control, official controls, border control, bcp, ched, chedd, cved, illegal import, illegally import, illegally imported, unauthorised import, unauthorized import, importation, unauthorised country, unauthorized country, non authorised country, non authorized country, pais no autorizado, unauthorised vessel, unauthorized vessel, unauthorised vessels, unauthorized vessels, buques no autorizados, reefer vessel, unauthorised operator, unauthorized operator, unauthorised company, unauthorized company, unauthorised establishment, unauthorized establishment, establecimiento no autorizado, unauthorised origin, unauthorized origin, origen no autorizado, unknown origin, identification mark, identification code, passports, attestation, analytical report, health certificate, certifcates, residue monitoring plan, traceability, cold chain, cadena de frio, temperature control, temperature failure',
  ],
];

const ADDED_HAZARD_PHRASES: readonly (readonly [target: string, keywords: string])[] = [
  ['pesticide-residues', 'mrl, lmr, maximum residue level, maximum residue levels'],
  ['other-pathogens', 'food poisoning'],
  ['other-contaminants', 'toxins, alkaloids'],
  ['undeclared-allergens', 'gluten, traces, not declared, incorrectly declared, improperly declared'],
  [
    'labelling',
    'unauthorised substance, unauthorized substance, unauthorised substances, unauthorized substances, prohibited substance, prohibited substances, prohibited ingredients, too high content, high content, vitamin, claims, unauthorised, unauthorized, non authorised, non authorized, not authorised, not authorized, no autorizado, no autorizada, no autorizados, no autorizadas',
  ],
  ['foreign-bodies', 'metal'],
];

const ADDED_COMMODITY_KEYWORDS: readonly (readonly [target: string, keywords: string])[] = [
  [
    'animal-feed',
    'dog food, dog chews, dog treats, dog snacks, for dogs, cat food, cat treats, for cats, pet treats, petfood, chews, birdseed, bird seed, bird feed, silage, fishmeal, premix, premixture, feedingstuff, feedingstuffs',
  ],
  ['food-supplements', 'tablets, sports food, pre workout, protein powder'],
  ['oils-fats', 'margarine, lard, shortening, tallow, fats'],
  [
    'confectionery-bakery',
    'chips, crisps, snack, snacks, crackers, cracker, bread, buns, pastry, pastries, croissant, croissants, muffin, muffins, doughnut, doughnuts, donut, donuts, brownie, brownies, waffle, waffles, rusk, rusks, sweets, toffee, toffees, lollipop, lollipops, marshmallow, marshmallows, gummy, gummies, caramel, caramels, candies, chewing gum, halva, halwa, baklava, honeycomb',
  ],
  ['beverages', 'water, waters, lemonade, soda, cola, liqueur, liquor, vodka, whisky, whiskey, rum, brandy, cognac, spirits, spirit, soju, cider, kombucha, smoothie, nectar'],
  ['tea-coffee-cocoa', 'matcha, rooibos, yerba mate, mate, infusion, infusions, cacao'],
  [
    'dried-fruit',
    'dried fruit, dried fruits, red date, red dates, dried longan, longan meat, dried mango, dried mangoes, dried plums, prunes, dried persimmon, jujube, jujubes, goji, dried mulberry, dried mulberries, dried orange, dried hawthorn, hawthorn, preserved plums, salted plums, dried banana, dried pineapple, dried papaya',
  ],
  ['nuts', 'betel nut, areca, supari, candlenut, walnut, walnuts, pecan, pecans, macadamia, macadamias, brazil nuts, pine nuts, pine kernels, chestnut, chestnuts, coconut, nut, nuts'],
  [
    'oilseeds',
    'sunflower seeds, sunflower seed, sunflower kernels, pumpkin seeds, pumpkin seed, poppy seeds, poppy seed, linseed, linseeds, flaxseed, flaxseeds, soybeans, soybean, soya beans, soy beans, rapeseed, canola, chia, hemp seeds, melon seeds, watermelon seeds, oilseeds',
  ],
  ['other-cereals', 'rye, buckwheat, quinoa, triticale, spelt, couscous, bulgur, vermicelli, macaroni, spaghetti, oat, oatmeal, porridge, bran, popcorn, tortilla, tortillas'],
  ['cereals', 'cereal, cereals, muesli, granola, grain, grains'],
  [
    'pulses',
    'pulses, legumes, kidney beans, black beans, red beans, white beans, broad beans, faba beans, fava beans, haricot beans, black eyed beans, black eyed peas, cowpeas, cowpea, split peas, urad, toor, daal, dhal, besan',
  ],
  ['shrimp', 'vannamei, langostinos, gambas, langoustines'],
  ['molluscs', 'ark shell, shellfish, snail, snails, escargot, abalone, whelk, whelks, conch, cockles, periwinkle'],
  [
    'fish',
    'barramundi, herring, cod, hake, sole, swordfish, pesce spada, bonito, trout, perch, pollock, haddock, snapper, eel, sprats, carp, basa, skipjack, yellowfin, sea bass, seabass, seabream, sea bream, bream, halibut, plaice, monkfish, mullet, mahi, grouper, croaker, mudfish, hilsa, pomfret, milkfish, whiting, saithe, redfish, escolar, marlin, sturgeon, kingfish',
  ],
  ['fish-seafood', 'crab, crabs, crawfish, crayfish, lobster, lobsters, seafood, sea cucumber, sea urchin, roe, caviar, surimi, crustaceans'],
  [
    'meat',
    'meat, veal, duck, goose, rabbit, horse meat, horsemeat, goat, venison, bacon, ham, salami, kebab, burger, burgers, mince, minced, offal, liver, livers, casings, bovine, porcine, ovine, swine, carcass, carcasses, frog legs, steak, steaks, ribs, wings, quail, jerky, chorizo',
  ],
  ['dairy', 'dairy, whey, casein, kefir, paneer, mozzarella, cheddar, feta, lactose, buttermilk'],
  [
    'mixed-spices',
    'oregano, basil, thyme, parsley, dill, mint, peppermint, spearmint, rosemary, sage, bay leaf, bay leaves, saffron, vanilla, fennel, anise, aniseed, allspice, savory, marjoram, tarragon, sumac, curry leaves, mustard seeds, mustard seed, caraway, juniper, lemongrass, galangal, seasoning, seasonings',
  ],
  ['spices-herbs', 'herbs, herb'],
  [
    'fruit-vegetables',
    // Seaweed sits here because the EU MRL classification files algae under vegetables.
    'fruit, fruits, vegetable, vegetables, cassava, casava, tapioca, manihot, spinach, palak, betel leaves, betel leaf, lime leaves, vine leaves, jute leaves, pandan, melinjo, dragon fruit, dragonfruit, pitaya, lychee, lychees, litchi, longan, longans, durian, rambutan, jackfruit, mangosteens, persimmon, guava, papaya, pineapple, mango, mangoes, banana, bananas, plantain, avocado, avocados, kiwi, pomegranate, citrus, orange, oranges, mandarin, mandarins, tangerines, clementines, lemon, lemons, lime, limes, grapefruit, pomelo, grapes, apple, apples, pear, pears, peach, peaches, nectarine, nectarines, plum, plums, cherry, cherries, strawberry, strawberries, raspberries, blueberries, berries, elderberry, bayberry, tamarind, melon, melons, watermelon, tomato, tomatoes, potato, potatoes, onion, onions, garlic, shallots, leek, leeks, carrot, carrots, cabbage, broccoli, cauliflower, lettuce, kale, okra, gourd, gourds, tindora, eggplant, aubergine, aubergines, brinjal, courgette, courgettes, zucchini, cucumber, cucumbers, pumpkin, squash, taro, yam, yams, radish, turnip, turnips, beetroot, asparagus, artichoke, bracken, mushroom, mushrooms, enoki, shiitake, peas, snow peas, sugar snap, green beans, long beans, long bean, snake beans, string beans, french beans, flat beans, hyacinth beans, papdi, surti, peppers, sweet peppers, bamboo shoots, lotus root, drumsticks, moringa, seaweed, seaweeds, kelp, nori, wakame, kombu, sea tangle, laver, hijiki, algae',
  ],
];

/** RASFF and UK product categories the seed left without a commodity. */
const ADDED_PRODUCT_CATEGORIES: readonly (readonly [category: string, target: string])[] = [
  ['alcoholic beverages', 'beverages'],
  ['wine', 'beverages'],
  ['natural mineral waters', 'beverages'],
  ['water for human consumption other', 'beverages'],
  ['cephalopods and products thereof', 'molluscs'],
  ['gastropods', 'molluscs'],
  ['compound feeds', 'animal-feed'],
  ['feed additives', 'animal-feed'],
  ['feed premixtures', 'animal-feed'],
];

/** The FDA refusal data writes the single-digit industry codes without their leading zero (`3`, not `03`). */
const UNPADDED_INDUSTRY_CODES: readonly (readonly [codes: string, target: string])[] = [
  ['2, 4, 5', 'other-cereals'],
  ['3, 7', 'confectionery-bakery'],
  ['9', 'dairy'],
];

/** One keyword rule per keyword and (source, field) pair. */
function scopedKeywordRules(
  table: readonly (readonly [target: string, keywords: string])[],
  scopes: readonly (readonly [source: RuleSource, field: string])[],
  priority: number,
): RuleSeed[] {
  return table.flatMap(([target, keywords]) =>
    split(keywords).flatMap((pattern) =>
      scopes.map(([source, field]): RuleSeed => ({ source, field, matchType: 'keyword', pattern, target, priority })),
    ),
  );
}

/** The commodity rules migration 0009_taxonomy_coverage inserted, after the seeded ones. */
export const COVERAGE_COMMODITY_RULES: readonly RuleSeed[] = [
  ...(['rasff', 'uk_bn'] as const).flatMap((source) =>
    ADDED_PRODUCT_CATEGORIES.map(([pattern, target]): RuleSeed => ({
      source,
      field: 'product_category',
      matchType: 'exact',
      pattern,
      target,
      priority: PRIORITY_CATEGORY,
    })),
  ),
  ...exactRules('fda_refusal', 'industry_code', UNPADDED_INDUSTRY_CODES, PRIORITY_INDUSTRY_CODE),
  ...scopedKeywordRules(ADDED_COMMODITY_KEYWORDS, ADDED_COMMODITY_FIELDS, PRIORITY_ADDED_COMMODITY),
];

/** The hazard rules migration 0009_taxonomy_coverage inserted, after the seeded ones. */
export const COVERAGE_HAZARD_RULES: readonly RuleSeed[] = [
  ...scopedKeywordRules(ADDED_HAZARD_KEYWORDS, ADDED_HAZARD_FIELDS, PRIORITY_ADDED_HAZARD),
  ...scopedKeywordRules(ADDED_HAZARD_PHRASES, ADDED_HAZARD_FIELDS, PRIORITY_ADDED_HAZARD_PHRASE),
];

/** Every commodity rule, in the order the migrations insert them (the order of their database ids). */
export const COMMODITY_RULES: readonly RuleSeed[] = [...SEED_COMMODITY_RULES, ...COVERAGE_COMMODITY_RULES];

/** Every hazard rule, in the order the migrations insert them (the order of their database ids). */
export const HAZARD_RULES: readonly RuleSeed[] = [...SEED_HAZARD_RULES, ...COVERAGE_HAZARD_RULES];
