import { HttpClient } from '@angular/common/http';
import { Component, inject, input, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AlertItem, MarkReadResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { AlertCount } from '../core/alert-count';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';

/** One alert, where an alert email links to: opening it marks it read. */
@Component({
  selector: 'app-alert-detail',
  imports: [RouterLink, Alert],
  template: `
    <a routerLink="/alerts" class="text-sm text-sky-700 underline">{{ i18n.t('web.alerts.allAlerts') }}</a>
    @if (alert.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (alert.hasValue()) {
      @let a = alert.value();
      <h1 class="mt-3 text-2xl font-semibold">{{ i18n.t('alerts.kind.' + a.kind) }}</h1>
      <dl class="mt-6 grid gap-x-6 gap-y-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <div>
          <dt class="text-sm text-slate-600">{{ i18n.t('web.alerts.severity') }}</dt>
          <dd>{{ i18n.t(a.severity === 'high' ? 'web.alerts.high' : 'web.alerts.normal') }}</dd>
        </div>
        <div>
          <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.date') }}</dt>
          <dd>{{ i18n.date(a.occurredOn) }}</dd>
        </div>
        @if (a.firm) {
          <div>
            <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.firm') }}</dt>
            <dd>
              <a [routerLink]="['/firms', a.firm.id]" class="text-sky-700 underline">{{ a.firm.displayName }}</a>
            </dd>
          </div>
        }
        @if (a.notice; as n) {
          <div>
            <dt class="text-sm text-slate-600">{{ i18n.t('web.notices.notice') }}</dt>
            <dd>
              <a [routerLink]="['/notices', n.id]" class="text-sky-700 underline">{{ n.productText ?? n.title ?? i18n.t('web.notices.notice') }}</a>
            </dd>
          </div>
          <div>
            <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.destination') }}</dt>
            <dd>{{ taxonomy.label('destination', n.destination) }}</dd>
          </div>
          <div>
            <dt class="text-sm text-slate-600">{{ i18n.t('web.topics.origin') }}</dt>
            <dd>{{ n.originCountry ? taxonomy.label('country', n.originCountry) : '—' }}</dd>
          </div>
        }
      </dl>
    } @else {
      <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class AlertDetail {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  private readonly alertCount = inject(AlertCount);
  private readonly http = inject(HttpClient);

  /** From the route. */
  readonly id = input.required<string>();

  protected readonly alert = resource({
    params: () => this.id(),
    loader: async ({ params: id }): Promise<AlertItem> => {
      const item = await firstValueFrom(this.http.get<AlertItem>(apiUrl(`/v1/alerts/${encodeURIComponent(id)}`)));
      if (item.readAt) return item;
      try {
        const { updated } = await firstValueFrom(this.http.post<MarkReadResponse>(apiUrl('/v1/alerts/read'), { ids: [item.id] }));
        this.alertCount.unread.update((count) => (count === null ? null : Math.max(0, count - updated)));
        return { ...item, readAt: new Date().toISOString() };
      } catch {
        // The alert still shows when marking it read fails; the next visit tries again.
        return item;
      }
    },
  });

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }
}
