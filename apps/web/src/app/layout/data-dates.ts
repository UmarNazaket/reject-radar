import { Component, inject, input } from '@angular/core';
import type { SourceFreshness } from '@rejectradar/contracts';
import { I18n } from '../core/i18n';

/** When each source last updated, flagging stale ones, and the line that the records are the agencies' own facts. */
@Component({
  selector: 'app-data-dates',
  template: `
    <section class="mt-6 text-sm text-slate-600">
      <h2 class="font-medium text-slate-700">{{ i18n.t('web.topics.freshness') }}</h2>
      <ul class="mt-2 grid gap-1 sm:grid-cols-2">
        @for (f of freshness(); track f.source) {
          <li>
            {{ i18n.t('web.source.' + f.source) }}:
            {{ f.lastSuccessAt ? i18n.date(f.lastSuccessAt) : i18n.t('web.topics.neverSynced') }}
            @if (f.stale) {
              <span class="ms-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">{{ i18n.t('web.topics.stale') }}</span>
            }
          </li>
        }
      </ul>
      <p class="mt-3">{{ i18n.t('web.topics.facts') }}</p>
    </section>
  `,
})
export class DataDates {
  protected readonly i18n = inject(I18n);
  readonly freshness = input.required<SourceFreshness[]>();
}
