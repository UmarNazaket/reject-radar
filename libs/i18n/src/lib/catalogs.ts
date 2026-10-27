import type { Locale } from '@rejectradar/contracts';
import {
  isLiteralElement,
  isPluralElement,
  isPoundElement,
  isSelectElement,
  isTagElement,
  parse,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';
import bn from '../catalogs/bn.json';
import en from '../catalogs/en.json';
import hi from '../catalogs/hi.json';
import ur from '../catalogs/ur.json';

/** Flat ICU catalog: `"email.verify.subject": "Verify your email for RejectRadar"`. */
export type Catalog = Readonly<Record<string, string>>;

export const CATALOGS: Readonly<Record<Locale, Catalog>> = { en, ur, hi, bn };

export type CatalogStatus = 'written' | 'machine-draft' | 'reviewed';

/** English is written by hand; the others are machine drafts until a native speaker has reviewed them. */
export const CATALOG_STATUS: Readonly<Record<Locale, CatalogStatus>> = {
  en: 'written',
  ur: 'machine-draft',
  hi: 'machine-draft',
  bn: 'machine-draft',
};

function collectArguments(
  elements: readonly MessageFormatElement[],
  into: Set<string>,
): void {
  for (const element of elements) {
    if (isLiteralElement(element) || isPoundElement(element)) continue;
    if (isTagElement(element)) {
      // A tag's value is its name, not an argument; only its children can read arguments.
      collectArguments(element.children, into);
      continue;
    }
    into.add(element.value);
    if (isSelectElement(element) || isPluralElement(element)) {
      for (const option of Object.values(element.options))
        collectArguments(option.value, into);
    }
  }
}

/** Sorted, de-duplicated argument names of an ICU message, including those nested in plural and select branches. */
export function messageArguments(message: string): string[] {
  const names = new Set<string>();
  collectArguments(parse(message), names);
  return [...names].sort();
}
