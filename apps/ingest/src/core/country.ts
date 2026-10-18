import { normalizeCountry } from '@rejectradar/matching';

/** Placeholders that mean "no country given": N/A, NA, none, unknown, dashes. */
const NOT_AVAILABLE = /^(n\/?a|none|unknown|-+)$/i;

const clean = (value: string | null | undefined): string => (value ?? '').trim();

/**
 * ISO 3166-1 alpha-2 code for a country name or code as written in a source, or null when it is blank,
 * a "not available" placeholder (a literal `NA` is not Namibia) or not recognised.
 */
export function countryFromName(value: string | null | undefined): string | null {
  const text = clean(value);
  if (text === '' || NOT_AVAILABLE.test(text)) return null;
  return normalizeCountry(text);
}

/**
 * FDA gives a `CountryCode` and a `CountryName`. The code `NA` is Namibia only when the name says so;
 * otherwise it is FDA's "not available". Any other code is used as given, falling back to the name.
 */
export function countryFromFda(code: string | null | undefined, name: string | null | undefined): string | null {
  const text = clean(code);
  if (text.toUpperCase() === 'NA') return clean(name).toLowerCase() === 'namibia' ? 'NA' : null;
  if (text !== '') {
    const fromCode = normalizeCountry(text);
    if (fromCode) return fromCode;
  }
  return countryFromName(name);
}
