export interface NormalizedName {
  /** First alias; '' when nothing usable remains. */
  primary: string;
  /** Every distinct normalised part, primary first. */
  aliases: string[];
}

/** Letters that NFKD does not decompose into a base letter plus accents. */
const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
  'đ': 'd', 'Đ': 'D', 'ð': 'd', 'Ð': 'D', 'ß': 'ss', 'ẞ': 'SS', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
  'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L', 'ı': 'i', 'þ': 'th', 'Þ': 'TH',
};
const SPECIAL_PATTERN = new RegExp(`[${Object.keys(SPECIAL_LETTERS).join('')}]`, 'gu');

/** d/b/a, dba, a/k/a, aka, t/a and "trading as", only when they stand alone as words. */
const ALIAS_MARKER =
  /(?<![a-z0-9])(?:d\s*\/\s*b\s*\/\s*a|d\.\s*b\.\s*a\.?|dba|a\s*\/\s*k\s*\/\s*a|a\.\s*k\.\s*a\.?|aka|t\s*\/\s*a|trading\s+as)(?![a-z0-9])/;

/** Removed from the start, longest first (spec §8.1 step 4). */
const LEADING_PREFIXES: readonly (readonly string[])[] = [
  ['cong', 'ty', 'co', 'phan'],
  ['mot', 'thanh', 'vien'],
  ['cong', 'ty', 'tnhh'],
  ['cong', 'ty', 'cp'],
  ['cong', 'ty'],
  ['m', 's'],
  ['messrs'],
  ['ctcp'],
  ['the'],
  ['mtv'],
  ['pt'],
  ['cv'],
];

/** Removed from the end, longest first (spec §8.1 step 5). */
const LEGAL_SUFFIXES: readonly (readonly string[])[] = [
  ['s', 'a', 'de', 'c', 'v'],
  ['sa', 'de', 'cv'],
  ['s', 'p', 'a'],
  ['s', 'r', 'l'],
  ['s', 'a', 's'],
  ['s', 'r', 'o'],
  ['l', 'l', 'c'],
  ['l', 'l', 'p'],
  ['p', 'l', 'c'],
  ['private', 'limited'],
  ['company', 'limited'],
  ['pvt', 'limited'],
  ['co', 'limited'],
  ['pvt', 'ltd'],
  ['co', 'ltd'],
  ['pte', 'ltd'],
  ['sdn', 'bhd'],
  ['fz', 'llc'],
  ['s', 'a'],
  ['a', 's'],
  ['incorporated'],
  ['corporation'],
  ['company'],
  ['limited'],
  ['private'],
  ['gmbh'],
  ['sarl'],
  ['ltda'],
  ['corp'],
  ['fzco'],
  ['ojsc'],
  ['cjsc'],
  ['pjsc'],
  ['fze'],
  ['fzc'],
  ['llc'],
  ['llp'],
  ['ltd'],
  ['plc'],
  ['pvt'],
  ['pte'],
  ['bhd'],
  ['tbk'],
  ['jsc'],
  ['inc'],
  ['srl'],
  ['spa'],
  ['sas'],
  ['sro'],
  ['kft'],
  ['wll'],
  ['est'],
  ['bv'],
  ['nv'],
  ['ag'],
  ['sa'],
  ['co'],
];

/** Abbreviations and common spellings unified to one form (spec §8.1 step 6). */
const TOKEN_MAP: Readonly<Record<string, string>> = {
  intl: 'international',
  natl: 'national',
  mfg: 'manufacturing',
  mfr: 'manufacturer',
  mfrs: 'manufacturers',
  ind: 'industries',
  inds: 'industries',
  indus: 'industries',
  bros: 'brothers',
  trdg: 'trading',
  mktg: 'marketing',
  ent: 'enterprises',
  enterp: 'enterprises',
  exp: 'exports',
  imp: 'imports',
  assoc: 'associates',
  coop: 'cooperative',
  mohammad: 'muhammad',
  mohammed: 'muhammad',
  muhammed: 'muhammad',
  mohamed: 'muhammad',
  muhamad: 'muhammad',
  mohd: 'muhammad',
  ahmed: 'ahmad',
  rehman: 'rahman',
  husain: 'hussain',
  hussein: 'hussain',
};

export function foldToAscii(value: string): string {
  return value
    .replace(SPECIAL_PATTERN, (letter) => SPECIAL_LETTERS[letter] ?? letter)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Whole legal units that the prefix and suffix rules remove, plus "and". */
const LEGAL_UNITS: readonly (readonly string[])[] = [...LEADING_PREFIXES, ...LEGAL_SUFFIXES, ['and']];

/**
 * False when nothing distinctive is left: an empty name, or one made only of whole legal-form units
 * (normalizeName keeps the last token, so "PT Tbk" becomes "tbk"). Such names must never auto-link.
 * Words that only appear inside a longer legal phrase ("thanh" in "mot thanh vien") still count as name words.
 */
export function isUsableName(nameNorm: string): boolean {
  const tokens = nameNorm.split(' ').filter(Boolean);
  // covered[i]: tokens[i..] splits completely into legal units.
  const covered = new Array<boolean>(tokens.length + 1).fill(false);
  covered[tokens.length] = true;
  for (let i = tokens.length - 1; i >= 0; i--) {
    covered[i] = LEGAL_UNITS.some(
      (unit) => i + unit.length <= tokens.length && unit.every((token, k) => tokens[i + k] === token) && covered[i + unit.length],
    );
  }
  return tokens.length > 0 && !covered[0];
}

export function normalizeName(raw: string | null | undefined): NormalizedName {
  if (!raw) return { primary: '', aliases: [] };
  const parts = splitAliases(foldToAscii(raw)).map(normalizePart).filter((part) => part.length > 0);
  const aliases = [...new Set(parts)];
  return { primary: aliases[0] ?? '', aliases };
}

/** Split on alias markers only when every side has text. */
function splitAliases(value: string): string[] {
  const parts = value.split(ALIAS_MARKER);
  return parts.length > 1 && parts.every((part) => part.trim().length > 0) ? parts : [value];
}

function normalizePart(part: string): string {
  const spaced = part.replace(/[&+]/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!spaced) return '';
  const tokens = stripTrailingSuffixes(stripLeadingPrefixes(spaced.split(' ')));
  return tokens.map((token) => TOKEN_MAP[token] ?? token).join(' ');
}

/** Remove leading prefixes repeatedly, never removing the last token. */
function stripLeadingPrefixes(tokens: string[]): string[] {
  let current = tokens;
  for (;;) {
    const prefix = LEADING_PREFIXES.find((candidate) => startsWithTokens(current, candidate));
    if (!prefix) return current;
    current = current.slice(prefix.length);
  }
}

/** Remove legal suffixes and a dangling "and" repeatedly, never removing the last token. */
function stripTrailingSuffixes(tokens: string[]): string[] {
  let current = tokens;
  for (;;) {
    const suffix = LEGAL_SUFFIXES.find((candidate) => endsWithTokens(current, candidate));
    if (suffix) {
      current = current.slice(0, current.length - suffix.length);
      continue;
    }
    if (current.length > 1 && current[current.length - 1] === 'and') {
      current = current.slice(0, -1);
      continue;
    }
    return current;
  }
}

function startsWithTokens(tokens: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length >= tokens.length) return false;
  return prefix.every((token, index) => tokens[index] === token);
}

function endsWithTokens(tokens: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length >= tokens.length) return false;
  const offset = tokens.length - suffix.length;
  return suffix.every((token, index) => tokens[offset + index] === token);
}
