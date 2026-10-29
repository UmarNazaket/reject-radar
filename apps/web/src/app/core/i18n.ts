import { DOCUMENT, inject, Injectable, signal } from '@angular/core';
// The locales module alone: the contracts barrel would pull every zod schema into the first download.
import { isLocale, type Locale, LOCALES, pickLocale, textDirection } from '@rejectradar/contracts/locales';
import { IntlMessageFormat } from 'intl-messageformat';

type Catalog = Readonly<Record<string, string>>;

const STORAGE_KEY = 'rr_locale';
/** Script fonts, loaded only for their language; English uses the system font. */
const FONTS: Partial<Record<Locale, string>> = {
  ur: 'Noto+Nastaliq+Urdu:wght@400..700',
  hi: 'Noto+Sans+Devanagari:wght@400..700',
  bn: 'Noto+Sans+Bengali:wght@400..700',
};

/** The language stored on this device, else the first browser language the app has, else English. */
function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isLocale(stored)) return stored;
  } catch {
    // Storage can be blocked; the browser language still applies.
  }
  return pickLocale(navigator.languages ?? []);
}

/**
 * The app's language: loads `/i18n/<locale>.json` (the same catalogs as the API's emails) and formats ICU messages with
 * Latin digits, as the emails do. A key missing from a language falls back to English, then to the key itself.
 */
@Injectable({ providedIn: 'root' })
export class I18n {
  private readonly document = inject(DOCUMENT);
  private readonly catalogs = signal<Partial<Record<Locale, Catalog>>>({});
  private readonly formatters = new Map<string, IntlMessageFormat>();
  readonly locale = signal<Locale>('en');
  readonly locales = LOCALES;

  /** Loads English and the starting language; the app waits for it before the first screen. */
  init(): Promise<void> {
    return this.use(initialLocale());
  }

  /** Switches the language: loads its catalog once, then sets `lang` and `dir` on the page. */
  async use(locale: Locale): Promise<void> {
    await Promise.all([this.load('en'), this.load(locale)]);
    this.locale.set(locale);
    const html = this.document.documentElement;
    html.lang = locale;
    html.dir = textDirection(locale);
    this.loadFont(locale);
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Not remembered on this device; the account's language still applies after sign-in.
    }
  }

  /** The message `key` in the current language. Reads signals, so templates update when the language changes. */
  t(key: string, params?: Record<string, string | number | Date>): string {
    const locale = this.locale();
    const catalogs = this.catalogs();
    const own = catalogs[locale]?.[key];
    const lang = own !== undefined ? locale : 'en';
    const message = own ?? catalogs.en?.[key];
    if (message === undefined) return key;
    const cacheKey = `${lang}\u0000${key}`;
    let formatter = this.formatters.get(cacheKey);
    if (!formatter) this.formatters.set(cacheKey, (formatter = new IntlMessageFormat(message, `${lang}-u-nu-latn`)));
    return String(formatter.format(params));
  }

  /** A `YYYY-MM-DD` day or ISO timestamp in the current language, read in UTC as the API counts days. */
  date(value: string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
    return new Intl.DateTimeFormat(`${this.locale()}-u-nu-latn`, { ...options, timeZone: 'UTC' }).format(new Date(value));
  }

  private async load(locale: Locale): Promise<void> {
    if (this.catalogs()[locale]) return;
    const res = await fetch(`/i18n/${locale}.json`);
    if (!res.ok) throw new Error(`Could not load the ${locale} catalog (HTTP ${res.status})`);
    const catalog = (await res.json()) as Catalog;
    this.catalogs.update((all) => ({ ...all, [locale]: catalog }));
  }

  private loadFont(locale: Locale): void {
    const family = FONTS[locale];
    const id = `font-${locale}`;
    if (!family || this.document.getElementById(id)) return;
    const link = this.document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
    this.document.head.appendChild(link);
  }
}
