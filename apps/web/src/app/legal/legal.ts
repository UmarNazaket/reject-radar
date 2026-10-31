import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { LanguageSelect } from '../layout/language-select';
import { LegalLinks } from './legal-links';
import { LEGAL_TEXT, type LegalPage } from './legal-text';

/** The terms, privacy and refund pages: public, in English, which the agreements are written in. */
@Component({
  selector: 'app-legal',
  imports: [RouterLink, Alert, LanguageSelect, LegalLinks],
  template: `
    <header class="flex items-center justify-between px-4 py-3 sm:px-6">
      <a routerLink="/" class="text-lg font-semibold text-slate-900">{{ i18n.t('web.app.name') }}</a>
      <app-language-select />
    </header>
    <main class="mx-auto max-w-3xl px-4 pt-6 pb-16 sm:px-6">
      @if (i18n.locale() !== 'en') {
        <p class="mb-4 text-sm text-slate-600">{{ i18n.t('web.legal.englishOnly') }}</p>
      }
      <article lang="en" dir="ltr" class="text-start">
        <h1 class="text-2xl font-semibold">{{ text().title }}</h1>
        @if (text().draft) {
          <app-alert kind="warn" class="mt-4 block">Draft: this text is not yet in force.</app-alert>
        }
        @for (s of text().sections; track s.heading) {
          <h2 class="mt-6 text-lg font-semibold">{{ s.heading }}</h2>
          @for (p of s.paragraphs; track $index) {
            <p class="mt-2 text-slate-700">{{ p }}</p>
          }
        }
      </article>
      <app-legal-links class="mt-10 block" />
    </main>
  `,
})
export class Legal {
  protected readonly i18n = inject(I18n);
  /** From the route's data. */
  readonly page = input.required<LegalPage>();
  protected readonly text = computed(() => LEGAL_TEXT[this.page()]);
}
