import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { NoticeItem } from '@rejectradar/contracts';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';

/** Notices as a table, each opening its own page, with a link to the agency's record. */
@Component({
  selector: 'app-notice-table',
  imports: [RouterLink],
  template: `
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-slate-600">
          <tr class="border-b border-slate-200">
            <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.topics.date') }}</th>
            <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.topics.destination') }}</th>
            @if (showOrigin()) {
              <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.topics.origin') }}</th>
            }
            <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.topics.product') }}</th>
            <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.topics.firm') }}</th>
            <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.topics.hazards') }}</th>
            <th scope="col" class="py-2 text-start font-medium"><span class="sr-only">{{ i18n.t('web.topics.source') }}</span></th>
          </tr>
        </thead>
        <tbody>
          @for (n of notices(); track n.id) {
            <tr class="border-b border-slate-100 align-top">
              <td class="py-2 pe-4 whitespace-nowrap">{{ i18n.date(n.noticeOn) }}</td>
              <td class="py-2 pe-4">{{ taxonomy.label('destination', n.destination) }}</td>
              @if (showOrigin()) {
                <td class="py-2 pe-4">{{ n.originCountry ? taxonomy.label('country', n.originCountry) : '—' }}</td>
              }
              <td class="py-2 pe-4">
                <a [routerLink]="['/notices', n.id]" class="text-sky-700 underline">{{ n.productText ?? n.title ?? '—' }}</a>
              </td>
              <td class="py-2 pe-4">
                @if (n.firmId) {
                  <a [routerLink]="['/firms', n.firmId]" class="text-sky-700 underline">{{ n.firmName ?? '—' }}</a>
                } @else {
                  {{ n.firmName ?? '—' }}
                }
              </td>
              <td class="py-2 pe-4">{{ hazardLabels(n.hazardIds) }}</td>
              <td class="py-2">
                @if (n.url) {
                  <a [href]="n.url" target="_blank" rel="noopener" class="text-sky-700 underline">{{ i18n.t('web.topics.source') }}</a>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class NoticeTable {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  readonly notices = input.required<NoticeItem[]>();
  /** Off where every notice has the same origin, as on a topic. */
  readonly showOrigin = input(true);

  protected hazardLabels(ids: number[]): string {
    return ids.map((id) => this.taxonomy.label('hazard', id)).join(', ') || '—';
  }
}
