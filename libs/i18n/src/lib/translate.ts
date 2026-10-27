import type { Locale } from '@rejectradar/contracts';
import { DEFAULT_LOCALE } from '@rejectradar/contracts';
import { IntlMessageFormat } from 'intl-messageformat';
import { CATALOGS, type Catalog } from './catalogs';

export type TranslateParams = Record<string, string | number | Date>;

export class MissingTranslationError extends Error {
  constructor(
    readonly locale: Locale,
    readonly key: string,
  ) {
    super(`Missing translation for "${key}" (${locale})`);
    this.name = 'MissingTranslationError';
  }
}

// One formatter per (catalog, locale, key). Keyed by the catalog object so tests that inject their own set never
// read a formatter built from the real one.
const FORMATTERS = new WeakMap<Catalog, Map<string, IntlMessageFormat>>();

function formatterFor(
  catalog: Catalog,
  locale: Locale,
  key: string,
): IntlMessageFormat | undefined {
  const message = catalog[key];
  if (message === undefined) return undefined;
  let byKey = FORMATTERS.get(catalog);
  if (!byKey) FORMATTERS.set(catalog, (byKey = new Map()));
  const cacheKey = `${locale}\u0000${key}`;
  let formatter = byKey.get(cacheKey);
  if (!formatter) {
    // `-u-nu-latn`: Latin digits in every language, so Bengali and Urdu figures read like the rest of the product.
    byKey.set(
      cacheKey,
      (formatter = new IntlMessageFormat(message, `${locale}-u-nu-latn`)),
    );
  }
  return formatter;
}

/**
 * Formats `key` in `locale`. A key missing from that locale falls back to English; one missing from English too is a
 * programming error and throws. The fourth argument lets tests inject their own catalogs.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: TranslateParams,
  catalogs: Readonly<Record<Locale, Catalog>> = CATALOGS,
): string {
  const formatter =
    formatterFor(catalogs[locale], locale, key) ??
    formatterFor(catalogs[DEFAULT_LOCALE], DEFAULT_LOCALE, key);
  if (!formatter) throw new MissingTranslationError(locale, key);
  return String(formatter.format(params));
}
