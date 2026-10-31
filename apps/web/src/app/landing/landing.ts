import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../core/i18n';
import { LanguageSelect } from '../layout/language-select';
import { LegalLinks } from '../legal/legal-links';

const FEATURES = ['topics', 'firms', 'alerts', 'mrl', 'bulk', 'languages'] as const;
const SOURCES = ['fda_refusal', 'import_alert', 'rasff', 'uk_bn', 'au_ifis'] as const;

/** The public front page at `/`, for signed-out visitors: what RejectRadar checks, where the data comes from, and the way in. */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, LanguageSelect, LegalLinks],
  template: `
    <header class="flex items-center justify-between px-4 py-3 sm:px-6">
      <span class="text-lg font-semibold text-slate-900">{{ i18n.t('web.app.name') }}</span>
      <div class="flex items-center gap-4">
        <a routerLink="/pricing" class="text-sm text-sky-700 underline">{{ i18n.t('web.pricing.title') }}</a>
        <a routerLink="/login" class="text-sm text-sky-700 underline">{{ i18n.t('web.login.submit') }}</a>
        <app-language-select />
      </div>
    </header>
    <main class="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <section class="max-w-3xl">
        <h1 class="text-3xl font-semibold text-slate-900 sm:text-4xl">{{ i18n.t('web.landing.title') }}</h1>
        <p class="mt-4 text-lg text-slate-700">{{ i18n.t('web.landing.intro') }}</p>
        <div class="mt-6 flex flex-wrap gap-3">
          <a routerLink="/signup" class="rounded-md bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-800">{{ i18n.t('web.landing.start') }}</a>
          <a routerLink="/pricing" class="rounded-md border border-slate-300 bg-white px-4 py-2 font-medium text-slate-800 hover:bg-slate-50">{{
            i18n.t('web.landing.plans')
          }}</a>
        </div>
      </section>

      <section class="mt-12" aria-labelledby="landing-features">
        <h2 id="landing-features" class="text-xl font-semibold">{{ i18n.t('web.landing.featuresTitle') }}</h2>
        <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          @for (f of features; track f) {
            <div class="rounded-lg border border-slate-200 bg-white p-4">
              <h3 class="font-medium">{{ i18n.t('web.landing.features.' + f + '.title') }}</h3>
              <p class="mt-1 text-sm text-slate-600">{{ i18n.t('web.landing.features.' + f + '.body') }}</p>
            </div>
          }
        </div>
      </section>

      <section class="mt-12" aria-labelledby="landing-sources">
        <h2 id="landing-sources" class="text-xl font-semibold">{{ i18n.t('web.landing.sourcesTitle') }}</h2>
        <p class="mt-1 text-slate-600">{{ i18n.t('web.landing.sourcesIntro') }}</p>
        <ul class="mt-3 flex flex-wrap gap-2 text-sm">
          @for (s of sources; track s) {
            <li class="rounded-full border border-slate-200 bg-white px-3 py-1">{{ i18n.t('web.noticeSource.' + s) }}</li>
          }
          <li class="rounded-full border border-slate-200 bg-white px-3 py-1">{{ i18n.t('web.landing.euMrl') }}</li>
        </ul>
        <a routerLink="/sources" class="mt-3 inline-block text-sm text-sky-700 underline">{{ i18n.t('web.landing.sourcesMore') }}</a>
      </section>
      <app-legal-links class="mt-12 block" />
    </main>
  `,
})
export class Landing {
  protected readonly i18n = inject(I18n);
  protected readonly features = FEATURES;
  protected readonly sources = SOURCES;
}
