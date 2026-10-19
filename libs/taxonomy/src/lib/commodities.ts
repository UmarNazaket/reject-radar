export interface CommoditySeed {
  id: number;
  slug: string;
  name: string;
  parentId: number | null;
  hsHeadings: string[];
  euMrlCodes: string[];
}

/** Fallback commodity for anything no rule recognises. */
export const OTHER_FOOD_ID = 1800;

/** Expands `1001-1005` into every heading in the range; anything else is kept as written. */
function expandHeadings(spec: string): string[] {
  const range = /^(\d{4})-(\d{4})$/.exec(spec);
  if (range === null) return [spec];
  const [from, to] = [Number(range[1]), Number(range[2])];
  return Array.from({ length: to - from + 1 }, (_, offset) => String(from + offset).padStart(4, '0'));
}

type Row = [id: number, slug: string, name: string, parentId: number | null, hs: string[], mrl: string[]];

const ROWS: Row[] = [
  [100, 'cereals', 'Cereals', null, ['10', '11'], ['0500000']],
  [101, 'rice', 'Rice', 100, ['1006'], ['0500060']],
  [102, 'other-cereals', 'Other cereals', 100, ['1001-1005', '1007', '1008', '1101-1104', '1902'], ['0500090', '0500030']],
  [200, 'spices-herbs', 'Spices and herbs', null, ['0904-0910'], ['0800000']],
  [201, 'chilli-paprika', 'Chilli and paprika', 200, ['090421', '090422'], ['0231020']],
  [202, 'turmeric', 'Turmeric', 200, ['091030'], ['0840030']],
  [203, 'cumin', 'Cumin', 200, ['090931', '090932'], ['0810050']],
  [204, 'black-pepper', 'Black pepper', 200, ['090411', '090412'], ['0820060']],
  [205, 'mixed-spices', 'Mixed and other spices', 200, ['0905-0910'], ['0800000']],
  [300, 'oilseeds', 'Oilseeds', null, ['12'], ['0401000']],
  [301, 'sesame', 'Sesame', 300, ['120740'], ['0401040']],
  [302, 'groundnuts', 'Groundnuts', 300, ['1202', '200811'], ['0401020']],
  [400, 'nuts', 'Nuts', null, ['0801', '0802'], ['0120000']],
  [401, 'cashew', 'Cashew', 400, ['080131', '080132'], ['0120030']],
  [402, 'pistachio', 'Pistachio', 400, ['080251', '080252'], ['0120100']],
  [403, 'almond', 'Almond', 400, ['080211', '080212'], ['0120010']],
  [404, 'hazelnut', 'Hazelnut', 400, ['080221', '080222'], ['0120060']],
  [500, 'dried-fruit', 'Dried fruit', null, ['0813', '0806'], []],
  [501, 'dates', 'Dates', 500, ['080410'], ['0161010']],
  [502, 'raisins', 'Raisins', 500, ['080620'], ['0151010']],
  [503, 'apricots', 'Apricots', 500, ['081310'], ['0140010']],
  [504, 'figs', 'Figs', 500, ['080420'], ['0161020']],
  [600, 'fruit-vegetables', 'Fresh fruit and vegetables', null, ['07', '08'], ['0100000', '0200000']],
  [700, 'pulses', 'Pulses', null, ['0713'], ['0300000']],
  [800, 'tea-coffee-cocoa', 'Tea, coffee and cocoa', null, ['0901', '0902', '18'], ['0600000']],
  [900, 'honey', 'Honey', null, ['0409'], ['1040000']],
  [1000, 'fish-seafood', 'Fish and seafood', null, ['03', '1604', '1605'], []],
  [1001, 'shrimp', 'Shrimp', 1000, ['030616', '030617', '160521', '160529'], []],
  [1002, 'fish', 'Fish', 1000, ['0302-0305', '1604'], []],
  [1003, 'molluscs', 'Molluscs', 1000, ['0307', '1605'], []],
  [1100, 'meat', 'Meat', null, ['02', '1601', '1602'], []],
  [1200, 'dairy', 'Dairy', null, ['0401-0406'], ['1020000']],
  [1300, 'confectionery-bakery', 'Confectionery and bakery', null, ['1704', '1806', '1905'], []],
  [1400, 'beverages', 'Beverages', null, ['2009', '22'], []],
  [1500, 'oils-fats', 'Oils and fats', null, ['15'], []],
  [1600, 'food-supplements', 'Food supplements', null, ['210690'], []],
  [1700, 'animal-feed', 'Animal feed', null, ['23'], []],
  [1800, 'other-food', 'Other food', null, ['21'], []],
];

export const COMMODITIES: readonly CommoditySeed[] = ROWS.map(([id, slug, name, parentId, hs, euMrlCodes]) => ({
  id,
  slug,
  name,
  parentId,
  hsHeadings: hs.flatMap(expandHeadings),
  euMrlCodes,
}));

const PARENT_BY_ID: ReadonlyMap<number, number | null> = new Map(COMMODITIES.map((c) => [c.id, c.parentId]));

/** The commodity's ancestors, nearest first, excluding itself. Unknown ids have none. */
export function ancestorIds(id: number): number[] {
  const ancestors: number[] = [];
  let parent = PARENT_BY_ID.get(id) ?? null;
  while (parent !== null) {
    ancestors.push(parent);
    parent = PARENT_BY_ID.get(parent) ?? null;
  }
  return ancestors;
}
