import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
// The plans module alone: the contracts barrel would pull every zod schema into this page.
import { PLAN_IDS, type PlanDefinition, PLANS } from '@rejectradar/contracts/plans';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { LanguageSelect } from '../layout/language-select';
import { LegalLinks } from '../legal/legal-links';

/** The public price list: every plan with its prices and limits (spec §10.1), from the same `PLANS` table as the API, so it pre-renders. */
@Component({
  selector: 'app-pricing',
  imports: [RouterLink, LanguageSelect, LegalLinks],
  template: `
    <header class="flex items-center justify-between px-4 py-3 sm:px-6">
      <a routerLink="/" class="text-lg font-semibold text-slate-900">{{ i18n.t('web.app.name') }}</a>
      <app-language-select />
    </header>
    <main class="mx-auto max-w-6xl px-4 pt-6 pb-16 sm:px-6">
      <h1 class="text-2xl font-semibold">{{ i18n.t('web.pricing.title') }}</h1>
      <p class="mt-1 text-slate-600">{{ i18n.t('web.pricing.intro') }}</p>
      <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        @for (p of plans; track p.id) {
          <section class="flex flex-col rounded-lg border border-slate-200 bg-white p-4">
            <h2 class="text-lg font-semibold">{{ p.name }}</h2>
            <p class="mt-1 text-sm text-slate-600">
              @if (p.monthlyPriceUsd === null) {
                {{ i18n.t('web.pricing.contact') }}
              } @else if (p.monthlyPriceUsd === 0) {
                {{ i18n.t('web.pricing.free') }}
              } @else {
                {{ i18n.t('web.pricing.perMonth', { price: p.monthlyPriceUsd }) }} · {{ i18n.t('web.pricing.perYear', { price: p.yearlyPriceUsd ?? 0 }) }}
              }
            </p>
            <ul class="mt-3 flex flex-1 flex-col gap-1 text-sm">
              @for (line of limits(p); track line) {
                <li>{{ line }}</li>
              }
            </ul>
            @if (p.monthlyPriceUsd !== null) {
              <a [routerLink]="session.signedIn() ? '/settings/billing' : '/signup'" class="mt-4 text-sm text-sky-700 underline">
                {{ i18n.t(session.signedIn() ? 'web.pricing.choose' : 'web.login.signup') }}
              </a>
            }
          </section>
        }
      </div>
      <app-legal-links class="mt-10 block" />
    </main>
  `,
})
export class Pricing {
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  protected readonly plans = PLAN_IDS.map((id) => PLANS[id]);

  constructor() {
    // The page is public; a signed-in visitor is still offered their billing page.
    void this.session.load().catch(() => null);
  }

  protected limits(l: PlanDefinition): string[] {
    return [
      this.i18n.t('web.pricing.lookups', { count: l.lookupsPerMonth }),
      this.i18n.t('web.pricing.watchlist', { count: l.watchlistSize }),
      this.i18n.t('web.pricing.members', { count: l.members }),
      l.noticeHistoryMonths === null ? this.i18n.t('web.pricing.allHistory') : this.i18n.t('web.pricing.history', { months: l.noticeHistoryMonths }),
      ...(l.pdf ? [this.i18n.t('web.pricing.pdf')] : []),
      ...(l.bulk ? [this.i18n.t('web.pricing.bulk', { rows: l.bulkRowsPerMonth })] : []),
      ...(l.apiCallsPerMonth > 0 ? [this.i18n.t('web.pricing.api', { calls: l.apiCallsPerMonth })] : []),
    ];
  }
}
