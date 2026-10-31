import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../core/i18n';
import { LanguageSelect } from '../layout/language-select';
import { LegalLinks } from './legal-links';

/** Each source and the agency page it comes from, in the order the README lists them. */
const SOURCES = [
  { id: 'fda_refusal', url: 'https://datadashboard.fda.gov/oii/cd/imprefusals.htm' },
  { id: 'import_alert', url: 'https://www.accessdata.fda.gov/cms_ia/ialist.html' },
  { id: 'rasff', url: 'https://webgate.ec.europa.eu/rasff-window/screen/search' },
  { id: 'uk_bn', url: 'https://www.data.gov.uk/dataset/6d74a70f-e25a-4d54-a2a6-325c7aa57d74' },
  { id: 'au_ifis', url: 'https://data.gov.au/data/dataset/imported-food-inspection-scheme-monthly-failing-food-reports' },
  { id: 'eu_mrl', url: 'https://ec.europa.eu/food/plant/pesticides/eu-pesticides-database/start/screen/mrls' },
] as const;

/** The public data-sources page: what each agency publishes, how far back RejectRadar keeps it and how often it is read. */
@Component({
  selector: 'app-sources',
  imports: [RouterLink, LanguageSelect, LegalLinks],
  template: `
    <header class="flex items-center justify-between px-4 py-3 sm:px-6">
      <a routerLink="/" class="text-lg font-semibold text-slate-900">{{ i18n.t('web.app.name') }}</a>
      <app-language-select />
    </header>
    <main class="mx-auto max-w-3xl px-4 pt-6 pb-16 sm:px-6">
      <h1 class="text-2xl font-semibold">{{ i18n.t('web.sources.title') }}</h1>
      <p class="mt-2 text-slate-700">{{ i18n.t('web.sources.intro') }}</p>
      @for (s of sources; track s.id) {
        <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4" [attr.aria-labelledby]="'source-' + s.id">
          <h2 [id]="'source-' + s.id" class="text-lg font-semibold">{{ i18n.t('web.sources.' + s.id + '.name') }}</h2>
          <p class="mt-1 text-slate-700">{{ i18n.t('web.sources.' + s.id + '.about') }}</p>
          <dl class="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-slate-600">{{ i18n.t('web.sources.history') }}</dt>
              <dd>{{ i18n.t('web.sources.' + s.id + '.since') }}</dd>
            </div>
            <div>
              <dt class="text-slate-600">{{ i18n.t('web.sources.refresh') }}</dt>
              <dd>{{ i18n.t('web.sources.' + s.id + '.refresh') }}</dd>
            </div>
          </dl>
          <a [href]="s.url" target="_blank" rel="noopener" class="mt-3 inline-block text-sm text-sky-700 underline">{{ i18n.t('web.sources.open') }}</a>
        </section>
      }
      <app-legal-links class="mt-10 block" />
    </main>
  `,
})
export class Sources {
  protected readonly i18n = inject(I18n);
  protected readonly sources = SOURCES;
}
