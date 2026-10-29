import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { NoticeItem } from '@rejectradar/contracts';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';

/** One notice as the agency published it, with a link to its Import Alert when it is a listing. */
@Component({
  selector: 'app-notice-detail',
  imports: [RouterLink, Alert],
  template: `
    <a routerLink="/notices" class="text-sm text-sky-700 underline">{{ i18n.t('web.notices.back') }}</a>
    @if (notice.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (notice.hasValue()) {
      @let n = notice.value();
      <h1 class="mt-3 text-2xl font-semibold">{{ n.productText ?? n.title ?? i18n.t('web.notices.notice') }}</h1>
      <dl class="mt-6 grid gap-x-6 gap-y-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <div>
          <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.date') }}</dt>
          <dd>{{ i18n.date(n.noticeOn) }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-600">{{ i18n.t('web.notices.source') }}</dt>
          <dd>{{ i18n.t('web.noticeSource.' + n.source) }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.destination') }}</dt>
          <dd>{{ taxonomy.label('destination', n.destination) }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.origin') }}</dt>
          <dd>{{ n.originCountry ? taxonomy.label('country', n.originCountry) : '—' }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.firm') }}</dt>
          <dd>{{ n.firmName ?? '—' }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.commodity') }}</dt>
          <dd>{{ n.commodityId ? taxonomy.label('commodity', n.commodityId) : '—' }}</dd>
        </div>
        <div class="sm:col-span-2">
          <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.hazards') }}</dt>
          <dd>{{ hazardLabels(n.hazardIds) }}</dd>
        </div>
        @if (n.title && n.productText) {
          <div class="sm:col-span-2">
            <dt class="text-sm text-slate-600">{{ i18n.t('web.notices.agencyTitle') }}</dt>
            <dd lang="en" dir="ltr" class="text-start">{{ n.title }}</dd>
          </div>
        }
      </dl>
      <div class="mt-4 flex flex-wrap gap-4 text-sm">
        @if (n.url) {
          <a [href]="n.url" target="_blank" rel="noopener" class="text-sky-700 underline">{{ i18n.t('web.notices.atAgency') }}</a>
        }
        @if (importAlertNumber(); as number) {
          <a [routerLink]="['/import-alerts', number]" class="text-sky-700 underline">{{ i18n.t('web.notices.importAlert', { number }) }}</a>
        }
      </div>
      <p class="mt-6 text-sm text-slate-600">{{ i18n.t('web.topics.facts') }}</p>
    } @else {
      <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class NoticeDetail {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  readonly id = input.required<string>();
  protected readonly notice = httpResource<NoticeItem>(() => apiUrl(`/v1/notices/${encodeURIComponent(this.id())}`));

  /** A listing's title is written by the Import Alert sync as "<firm> on Import Alert <number>". */
  protected readonly importAlertNumber = computed(() => {
    const n = this.notice.hasValue() ? this.notice.value() : null;
    return n?.source === 'import_alert' ? /Import Alert (\d{2}-\d{2,3})$/.exec(n.title ?? '')?.[1] : undefined;
  });

  protected hazardLabels(ids: number[]): string {
    return ids.map((id) => this.taxonomy.label('hazard', id)).join(', ') || '—';
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }
}
