import { foldToAscii } from './normalize-name';
import { tokenSetJaroWinkler } from './similarity';

export interface RawAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface NormalizedAddress {
  /** ISO 3166-1 alpha-2, uppercase; null when not recognised. */
  countryCode: string | null;
  region: string | null;
  city: string | null;
  postalCode: string | null;
  /** Folded address-line tokens, abbreviations unified, filler words dropped. */
  addressNorm: string | null;
}

/** Long or old forms that the English region names don't cover. Keys are folded (see foldName). */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  'united kingdom of great britain and northern ireland': 'GB',
  usa: 'US', 'u s a': 'US', 'u s': 'US', 'united states of america': 'US',
  'viet nam': 'VN', turkey: 'TR', turkiye: 'TR',
  'south korea': 'KR', 'korea south': 'KR', 'korea republic of': 'KR', 'republic of korea': 'KR',
  'korea democratic people s republic of': 'KP', 'north korea': 'KP',
  'iran islamic republic of': 'IR', 'hong kong': 'HK', 'hong kong sar': 'HK', 'macao sar': 'MO', macau: 'MO',
  'taiwan province of china': 'TW', 'russian federation': 'RU',
  'tanzania united republic of': 'TZ', 'united republic of tanzania': 'TZ',
  'ivory coast': 'CI', 'cote d ivoire': 'CI', burma: 'MM', 'syrian arab republic': 'SY',
  laos: 'LA', 'lao people s democratic republic': 'LA', 'moldova republic of': 'MD',
  'bolivia plurinational state of': 'BO', 'venezuela bolivarian republic of': 'VE',
  holland: 'NL', 'the netherlands': 'NL', 'czech republic': 'CZ',
  uae: 'AE', 'u a e': 'AE', ksa: 'SA', 'kingdom of saudi arabia': 'SA',
  palestine: 'PS', 'palestine state of': 'PS', swaziland: 'SZ', 'cape verde': 'CV', macedonia: 'MK', 'east timor': 'TL',
  'dr congo': 'CD', 'democratic republic of the congo': 'CD', 'congo democratic republic of the': 'CD', 'republic of the congo': 'CG',
  myanmar: 'MM', 'cabo verde': 'CV', macao: 'MO', 'brunei darussalam': 'BN', 'islamic republic of iran': 'IR',
  'u k': 'GB', 'republic of ireland': 'IE',
};

/** Region codes with English names that are not countries: user-assigned, exceptionally reserved, or EU/UN bodies. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'ZZ', 'XA', 'XB', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ']);

const CITY_ALIASES: Readonly<Record<string, string>> = {
  bombay: 'mumbai', calcutta: 'kolkata', madras: 'chennai', bangalore: 'bengaluru', poona: 'pune', baroda: 'vadodara',
  cochin: 'kochi', trivandrum: 'thiruvananthapuram', saigon: 'ho chi minh city', hcmc: 'ho chi minh city',
  'ho chi minh': 'ho chi minh city', 'tp ho chi minh': 'ho chi minh city', 'tp hcm': 'ho chi minh city',
  peking: 'beijing', dacca: 'dhaka', chittagong: 'chattogram', lyallpur: 'faisalabad',
};

const POSTCODE_PLACEHOLDERS = new Set(['NA', 'NONE', 'NULL', 'NIL', 'UNKNOWN']);

const ADDRESS_TOKENS: Readonly<Record<string, string>> = {
  rd: 'road', st: 'street', str: 'street', ave: 'avenue', av: 'avenue', blvd: 'boulevard', hwy: 'highway',
  ind: 'industrial', indl: 'industrial', dist: 'district', distt: 'district', vill: 'village', sec: 'sector',
  bldg: 'building', fl: 'floor', flr: 'floor',
};
const ADDRESS_FILLER = new Set(['no', 'nos', 'number', 'near', 'opp', 'opposite']);

interface CountryTables {
  /** Country-name key to code, from the runtime's ICU English names. */
  byName: Map<string, string>;
  /** Hand-written long and old forms, keyed the same way as byName. */
  aliases: Map<string, string>;
  codes: Set<string>;
}

let countryTables: CountryTables | null = null;

/** False for retired or reserved codes that ICU still names (UK, SU, FX, YU, ZR, TP…); they would shadow the real code. */
function isCanonicalRegion(code: string): boolean {
  return Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`;
}

/** Built once: ICU English region names and the alias table, both keyed by countryKey. */
function getCountryTables(): CountryTables {
  if (countryTables) return countryTables;
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });
  const byName = new Map<string, string>();
  const codes = new Set<string>();
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      if (NOT_COUNTRIES.has(code) || !isCanonicalRegion(code)) continue;
      const name = names.of(code);
      if (!name || name === code) continue;
      codes.add(code);
      byName.set(countryKey(name), code);
    }
  }
  const aliases = new Map<string, string>();
  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) aliases.set(countryKey(name), code);
  countryTables = { byName, aliases, codes };
  return countryTables;
}

function foldName(value: string): string {
  return foldToAscii(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Comparison key for country names: folded, without "and"/"the", "saint" as "st". */
function countryKey(value: string): string {
  return foldName(value)
    .split(' ')
    .filter((token) => token !== 'and' && token !== 'the')
    .map((token) => (token === 'saint' ? 'st' : token))
    .join(' ');
}

function cleanText(value?: string | null): string | null {
  if (!value) return null;
  return foldName(value) || null;
}

export function normalizeCountry(value?: string | null): string | null {
  if (!value) return null;
  const key = countryKey(value);
  if (!key) return null;
  const { byName, aliases, codes } = getCountryTables();
  const alias = aliases.get(key);
  if (alias) return alias;
  const upper = foldName(value).toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && codes.has(upper)) return upper;
  return byName.get(key) ?? null;
}

export function normalizeCity(value?: string | null): string | null {
  const city = cleanText(value);
  return city ? (CITY_ALIASES[city] ?? city) : null;
}

export function normalizePostalCode(value?: string | null): string | null {
  if (!value) return null;
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 3 || /^0+$/.test(code) || POSTCODE_PLACEHOLDERS.has(code)) return null;
  return code;
}

export function normalizeAddressLine(...lines: (string | null | undefined)[]): string | null {
  const joined = cleanText(lines.filter((line): line is string => !!line && line.trim().length > 0).join(' '));
  if (!joined) return null;
  const tokens = joined
    .split(' ')
    .filter((token) => !ADDRESS_FILLER.has(token))
    .map((token) => ADDRESS_TOKENS[token] ?? token);
  return tokens.length > 0 ? tokens.join(' ') : null;
}

/**
 * Spec §8.2: token-set Jaro-Winkler of normalised address lines, 0 unless both have `minTokens` words.
 * P3-D3: also 0 unless the words that contain a digit are the same set on both sides (or neither side has any), so
 * "plot 23" and "plot 25" are different addresses however alike the rest is.
 */
export function addressSimilarity(a: string | null, b: string | null, minTokens = 3): number {
  if (!a || !b) return 0;
  if (a.split(' ').length < minTokens || b.split(' ').length < minTokens) return 0;
  if (!sameNumbers(a, b)) return 0;
  return tokenSetJaroWinkler(a, b);
}

/** The words of an address line that contain a digit: plot, house and sector numbers, "23a", postcodes. */
function numberWords(address: string): Set<string> {
  return new Set(address.split(' ').filter((word) => /\d/.test(word)));
}

function sameNumbers(a: string, b: string): boolean {
  const numbersA = numberWords(a);
  const numbersB = numberWords(b);
  return numbersA.size === numbersB.size && [...numbersA].every((word) => numbersB.has(word));
}

/**
 * What may stand between the words of an address and its location tail: any character other than a-z and 0-9 once
 * folded, the words' own alphabet. Besides spaces, commas and semicolons, that is the "." of "Hebei Prov." or "CHINA."
 * and the ")" of "REPUBLIC OF (SOUTH)".
 */
const TAIL_SEPARATOR = /[^a-z0-9]/;

/**
 * Cuts the city, region and country off the end of an address that carries them (P3-D3): an Import Alert `address_raw`
 * reads "…, FUQING, Fujian CHINA", while an FDA address line holds the street only. The comparison is on folded text and
 * whole words, from the end, trying country, then region, then city, for as long as one of them matches; the
 * punctuation and spaces around each cut go with it. The result is the matching prefix of `raw`, in its own spelling,
 * or `raw` itself when it has no such tail.
 */
export function stripLocationTail(
  raw: string,
  parts: { city?: string | null; region?: string | null; country?: string | null },
): string {
  const tails = [parts.country, parts.region, parts.city].flatMap((part) => {
    const words = part ? foldToAscii(part).match(/[a-z0-9]+/g) : null;
    return words ? [new RegExp(`(?<![a-z0-9])${words.join('[^a-z0-9]+')}$`)] : [];
  });
  if (tails.length === 0) return raw;

  // Folding one character at a time lets every folded character say where its source character ends in `raw`.
  let folded = '';
  const ends: number[] = [];
  let offset = 0;
  for (const char of raw) {
    offset += char.length;
    const piece = foldToAscii(char);
    folded += piece;
    for (let i = 0; i < piece.length; i++) ends.push(offset);
  }

  let end = folded.length;
  let cut = false;
  for (;;) {
    while (end > 0 && TAIL_SEPARATOR.test(folded[end - 1])) end--;
    const head = folded.slice(0, end);
    const match = firstMatch(tails, head);
    if (!match) break;
    end = match.index;
    cut = true;
  }
  if (!cut) return raw;
  return end === 0 ? '' : raw.slice(0, ends[end - 1]);
}

function firstMatch(patterns: readonly RegExp[], text: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

export function normalizeAddress(address: RawAddress | null | undefined): NormalizedAddress | null {
  if (!address) return null;
  const normalized: NormalizedAddress = {
    countryCode: normalizeCountry(address.country),
    region: cleanText(address.region),
    city: normalizeCity(address.city),
    postalCode: normalizePostalCode(address.postalCode),
    addressNorm: normalizeAddressLine(address.line1, address.line2),
  };
  return Object.values(normalized).some((value) => value !== null) ? normalized : null;
}
