import { foldToAscii } from '@rejectradar/matching';
import * as cheerio from 'cheerio';

export const EU_MRL_FILES: readonly string[] = [1, 2, 3, 4, 5, 6, 7, 8].map(
  (n) => `https://ec.europa.eu/food/plant/pesticides/eu-pesticides-database/backend/api/mrl/download/link?filename=Publication${n}.xml`,
);

export interface MrlParse {
  /** Product code to product name. */
  products: Map<string, string>;
  residues: { id: string; name: string; nameNorm: string }[];
  mrls: {
    productCode: string;
    residueId: string;
    /** Decimal text, e.g. `0.01`; `null` means "no MRL required" (a limit is not needed). */
    mrlMgKg: string | null;
    /** True for a limit written `0.01*`: the limit of analytical determination. */
    isLod: boolean;
    legalRef: string | null;
    /** `YYYY-MM-DD`. */
    applicableFrom: string | null;
  }[];
}

const PRODUCT_CODE = /^\d{7}$/;
const NUMBER = /^\d+(?:\.\d+)?$/;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `DD/MM/YYYY` to `YYYY-MM-DD`; empty text is `null`, anything else that is not a real date throws. */
function isoDate(text: string, what: string): string | null {
  if (text === '') return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) throw new Error(`${what} "${text}" is not DD/MM/YYYY`);
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) throw new Error(`${what} "${text}" is not a real date`);
  return iso;
}

/**
 * A limit value: `0.5` is a limit, `0.01*` is a limit at the limit of determination, `No MRL Required` (any case) is
 * a substance that needs no limit. Empty text means no limit information and gives `null` (no row). Any other text
 * throws, so a new notation never drops data silently.
 */
function parseLimit(text: string, where: string): { mrlMgKg: string | null; isLod: boolean } | null {
  if (text === '') return null;
  // A NULL limit means "no MRL required", which differs from "no limit set" (no row at all).
  if (text.toLowerCase() === 'no mrl required') return { mrlMgKg: null, isLod: false };
  const isLod = text.endsWith('*');
  const number = isLod ? text.slice(0, -1).trim() : text;
  if (!NUMBER.test(number)) throw new Error(`MRL value "${text}" of ${where} is neither a number nor "No MRL Required"`);
  return { mrlMgKg: number, isLod };
}

/**
 * Parses one EU Pesticides Database MRL export (`Publication<n>.xml`): `Pesticides` holds repeated `Substances`,
 * each with its `Product` rows. Every product is kept; products with an `MRL` (a number or `No MRL Required`) get an `mrls` row.
 */
export function parseMrlXml(xml: string): MrlParse {
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first();
  if (root.length === 0 || root.get(0)?.tagName !== 'Pesticides') throw new Error('Expected the root element Pesticides');
  const substances = root.children('Substances');
  if (substances.length === 0) throw new Error('The file holds no Substances');

  const products = new Map<string, string>();
  const residues: MrlParse['residues'] = [];
  const mrls: MrlParse['mrls'] = [];

  substances.each((_, substanceNode) => {
    const substance = $(substanceNode);
    const text = (parent: typeof substance, tag: string) => squash(parent.children(tag).first().text());
    const id = text(substance, 'Pest_res_id');
    const name = text(substance, 'Name');
    if (id === '' || name === '') throw new Error('A Substances element lacks Pest_res_id or Name');
    const legalRef = text(substance, 'directive') || null;
    const entryForce = isoDate(text(substance, 'entry_force'), `entry_force of ${name}`);
    residues.push({ id, name, nameNorm: foldToAscii(name).toLowerCase() });

    substance.children('Product').each((__, productNode) => {
      const row = $(productNode);
      const code = text(row, 'Product_code');
      if (!PRODUCT_CODE.test(code)) throw new Error(`Product_code "${code}" of ${name} is not 7 digits`);
      if (!products.has(code)) products.set(code, text(row, 'Product_name'));
      const limit = parseLimit(text(row, 'MRL'), `${name} / product ${code}`);
      if (limit === null) return;
      mrls.push({
        productCode: code,
        residueId: id,
        ...limit,
        legalRef,
        applicableFrom: isoDate(text(row, 'ApplicationDate'), `ApplicationDate of ${name} / ${code}`) ?? entryForce,
      });
    });
  });

  return { products, residues, mrls };
}

/**
 * The parent of a product code in the EU hierarchy: the first of the group codes at 5, 4, 3 and 2 leading digits
 * (zero padded) that differs from `code` and is a known product. `null` for a top-level code.
 */
export function parentCode(code: string, known: ReadonlySet<string>): string | null {
  const candidates = [code.slice(0, 5) + '00', code.slice(0, 4) + '000', code.slice(0, 3) + '0000', code.slice(0, 2) + '00000'];
  return candidates.find((candidate) => candidate !== code && known.has(candidate)) ?? null;
}
