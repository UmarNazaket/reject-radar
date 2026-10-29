import { httpResource } from '@angular/common/http';
import { Component, inject, input } from '@angular/core';
import type { ImportAlertResponse } from '@rejectradar/contracts';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';

/** An FDA Import Alert: the plain-language summary when one may be shown, then FDA's own text in English. */
@Component({
  selector: 'app-import-alert',
  imports: [Alert],
  template: `
    @if (alert.error(); as error) {
      <app-alert>{{ errorText(error) }}</app-alert>
    } @else if (alert.hasValue()) {
      @let a = alert.value();
      <p class="text-sm text-slate-600">{{ i18n.t('web.importAlert.number', { number: a.number }) }}</p>
      <h1 class="mt-1 text-start text-2xl font-semibold" lang="en" dir="ltr">{{ a.title }}</h1>
      <p class="mt-2 text-sm text-slate-600">
        @if (a.publishedOn) {
          {{ i18n.t('web.importAlert.published', { date: i18n.date(a.publishedOn) }) }}
        }
        @if (a.alertType) {
          · <span lang="en" dir="ltr">{{ a.alertType }}</span>
        }
      </p>
      @if (a.removed) {
        <app-alert kind="warn" class="mt-4 block">{{ i18n.t('web.importAlert.removed') }}</app-alert>
      }

      @if (a.summary; as summary) {
        <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4" [attr.lang]="summary.locale">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="font-medium">{{ i18n.t('web.importAlert.summary') }}</h2>
            @if (summary.status === 'machine') {
              <span class="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{{ i18n.t('web.importAlert.machine') }}</span>
            }
          </div>
          @if (summary.locale !== i18n.locale()) {
            <p class="mt-1 text-sm text-slate-600">{{ i18n.t('web.importAlert.englishOnly') }}</p>
          }
          <p class="mt-3">{{ summary.content.summary }}</p>
          <h3 class="mt-4 text-sm font-medium text-slate-700">{{ i18n.t('web.importAlert.triggers') }}</h3>
          <p class="mt-1">{{ summary.content.whatTriggersListing }}</p>
          <h3 class="mt-4 text-sm font-medium text-slate-700">{{ i18n.t('web.importAlert.removal') }}</h3>
          <p class="mt-1">{{ summary.content.howFirmsGetRemoved }}</p>
          @if (summary.content.testsMentioned.length > 0) {
            <h3 class="mt-4 text-sm font-medium text-slate-700">{{ i18n.t('web.importAlert.tests') }}</h3>
            <ul class="mt-1 list-disc ps-5">
              @for (test of summary.content.testsMentioned; track $index) {
                <li>{{ test }}</li>
              }
            </ul>
          }
        </section>
      }

      <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="font-medium">{{ i18n.t('web.importAlert.fdaText') }}</h2>
        @for (part of parts(a); track part.key) {
          <h3 class="mt-4 text-sm font-medium text-slate-700">{{ i18n.t(part.key) }}</h3>
          <p class="mt-1 text-start whitespace-pre-line" lang="en" dir="ltr">{{ part.text }}</p>
        }
        <a [href]="a.url" target="_blank" rel="noopener" class="mt-4 inline-block text-sm text-sky-700 underline">{{ i18n.t('web.importAlert.atFda') }}</a>
      </section>
      <p class="mt-6 text-sm text-slate-600">{{ i18n.t('web.topics.facts') }}</p>
    } @else {
      <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class ImportAlert {
  protected readonly i18n = inject(I18n);
  readonly number = input.required<string>();
  protected readonly alert = httpResource<ImportAlertResponse>(() => ({
    url: apiUrl(`/v1/import-alerts/${encodeURIComponent(this.number())}`),
    params: { locale: this.i18n.locale() },
  }));

  /** FDA's sections that have text, each under its heading. */
  protected parts(a: ImportAlertResponse): { key: string; text: string }[] {
    const parts = [
      { key: 'web.importAlert.reason', text: a.reasonText },
      { key: 'web.importAlert.guidance', text: a.guidanceText },
      { key: 'web.importAlert.products', text: a.productText },
      { key: 'web.importAlert.charge', text: a.chargeText },
    ];
    return parts.filter((part): part is { key: string; text: string } => !!part.text);
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }
}
