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
  korea: 'KR', 'south korea': 'KR', 'korea south': 'KR', 'korea republic of': 'KR', 'republic of korea': 'KR',
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
};

/** Region codes with English names that are not countries. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'ZZ', 'XA', 'XB']);

const CITY_ALIASES: Readonly<Record<string, string>> = {
  bombay: 'mumbai', calcutta: 'kolkata', madras: 'chennai', bangalore: 'bengaluru', poona: 'pune', baroda: 'vadodara',
  cochin: 'kochi', trivandrum: 'thiruvananthapuram', saigon: 'ho chi minh city', hcmc: 'ho chi minh city',
  'ho chi minh': 'ho chi minh city', 'tp ho chi minh': 'ho chi minh city', 'tp hcm': 'ho chi minh city',
  peking: 'beijing', canton: 'guangzhou', dacca: 'dhaka', chittagong: 'chattogram', lyallpur: 'faisalabad',
};

const POSTCODE_PLACEHOLDERS = new Set(['NA', 'NONE', 'NULL', 'NIL', 'UNKNOWN']);

const ADDRESS_TOKENS: Readonly<Record<string, string>> = {
  rd: 'road', st: 'street', str: 'street', ave: 'avenue', av: 'avenue', blvd: 'boulevard', hwy: 'highway',
  ind: 'industrial', indl: 'industrial', dist: 'district', distt: 'district', vill: 'village', sec: 'sector',
  bldg: 'building', fl: 'floor', flr: 'floor',
};
const ADDRESS_FILLER = new Set(['no', 'nos', 'number', 'near', 'opp', 'opposite']);

let countryTables: { byName: Map<string, string>; codes: Set<string> } | null = null;

/** False for retired or reserved codes that ICU still names (UK, SU, FX, YU, ZR, TP…); they would shadow the real code. */
function isCanonicalRegion(code: string): boolean {
  return Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`;
}

/** English region names from the runtime's ICU data, keyed by their folded form. Built once. */
function getCountryTables(): { byName: Map<string, string>; codes: Set<string> } {
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
      byName.set(foldName(name), code);
    }
  }
  countryTables = { byName, codes };
  return countryTables;
}

function foldName(value: string): string {
  return foldToAscii(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanText(value?: string | null): string | null {
  if (!value) return null;
  return foldName(value) || null;
}

export function normalizeCountry(value?: string | null): string | null {
  if (!value) return null;
  const folded = foldName(value);
  if (!folded) return null;
  const alias = COUNTRY_ALIASES[folded];
  if (alias) return alias;
  const { byName, codes } = getCountryTables();
  const upper = folded.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && codes.has(upper)) return upper;
  return byName.get(folded) ?? null;
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

/** Spec §8.2: token-set Jaro-Winkler of normalised address lines, 0 unless both have `minTokens` words. */
export function addressSimilarity(a: string | null, b: string | null, minTokens = 3): number {
  if (!a || !b) return 0;
  if (a.split(' ').length < minTokens || b.split(' ').length < minTokens) return 0;
  return tokenSetJaroWinkler(a, b);
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
