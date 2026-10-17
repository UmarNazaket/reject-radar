export const LOCALES = ['en', 'ur', 'hi', 'bn'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

const RIGHT_TO_LEFT: ReadonlySet<Locale> = new Set<Locale>(['ur']);

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function textDirection(locale: Locale): 'ltr' | 'rtl' {
  return RIGHT_TO_LEFT.has(locale) ? 'rtl' : 'ltr';
}

/** First supported language from a list such as navigator.languages or a parsed Accept-Language header. */
export function pickLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}
