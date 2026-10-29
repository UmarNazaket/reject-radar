import { Component, inject } from '@angular/core';
import type { Locale } from '@rejectradar/contracts/locales';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';

/** Each language in its own script, so anyone can find theirs whatever the current language is. */
const NAMES: Record<Locale, string> = { en: 'English', ur: 'اردو', hi: 'हिन्दी', bn: 'বাংলা' };

@Component({
  selector: 'app-language-select',
  template: `
    <select
      class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
      [attr.aria-label]="i18n.t('web.language')"
      [value]="i18n.locale()"
      (change)="change($any($event.target).value)"
    >
      @for (locale of i18n.locales; track locale) {
        <option [value]="locale" [selected]="locale === i18n.locale()">{{ names[locale] }}</option>
      }
    </select>
  `,
})
export class LanguageSelect {
  protected readonly i18n = inject(I18n);
  private readonly session = inject(Session);
  protected readonly names = NAMES;

  protected change(locale: Locale): void {
    void this.session.setLocale(locale);
  }
}
