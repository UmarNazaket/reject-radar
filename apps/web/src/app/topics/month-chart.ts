import { Component, computed, inject, input } from '@angular/core';
import type { DashboardResponse, Destination } from '@rejectradar/contracts';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';

/** One fixed colour per destination, so a filter never repaints the ones left (validated for colour-blind readers). */
export const DESTINATION_COLORS: Record<Destination, string> = { US: '#2a78d6', EU: '#eb6834', UK: '#1baf7a', AU: '#eda100' };

/** Notices per month as bars stacked by destination, with a legend, a tooltip per month and a table for screen readers. */
@Component({
  selector: 'app-month-chart',
  template: `
    <figure>
      <ul class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700" aria-hidden="true">
        @for (d of destinations(); track d) {
          <li class="flex items-center gap-1.5"><span class="size-3 rounded-sm" [style.background]="colors[d]"></span>{{ taxonomy.label('destination', d) }}</li>
        }
      </ul>
      <div class="mt-3 flex h-48 items-end gap-0.5 border-b border-slate-300" aria-hidden="true">
        @for (m of months(); track m.month) {
          <div class="flex h-full min-w-0 flex-1 flex-col-reverse gap-0.5 hover:bg-slate-100" [title]="tooltip(m)">
            @for (d of destinations(); track d) {
              @if (m[d] > 0) {
                <div class="w-full last:rounded-t" [style.height.%]="(m[d] / max()) * 100" [style.background]="colors[d]"></div>
              }
            }
          </div>
        }
      </div>
      <div class="mt-1 flex justify-between text-xs text-slate-500" aria-hidden="true">
        <span>{{ monthLabel(months()[0].month) }}</span>
        <span>{{ monthLabel(months()[months().length - 1].month) }}</span>
      </div>
      <div class="sr-only">
        <table>
          <caption>{{ caption() }}</caption>
          <tr>
            <th scope="col">{{ i18n.t('web.topics.month') }}</th>
            @for (d of destinations(); track d) {
              <th scope="col">{{ taxonomy.label('destination', d) }}</th>
            }
          </tr>
          @for (m of months(); track m.month) {
            <tr>
              <th scope="row">{{ monthLabel(m.month) }}</th>
              @for (d of destinations(); track d) {
                <td>{{ m[d] }}</td>
              }
            </tr>
          }
        </table>
      </div>
    </figure>
  `,
})
export class MonthChart {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  /** At least one month: the API always sends the months it covers, zero-filled. */
  readonly months = input.required<DashboardResponse['months']>();
  readonly destinations = input.required<Destination[]>();
  readonly caption = input.required<string>();
  protected readonly colors = DESTINATION_COLORS;
  protected readonly max = computed(() => Math.max(1, ...this.months().map((m) => this.destinations().reduce((sum, d) => sum + m[d], 0))));

  protected monthLabel(month: string): string {
    return this.i18n.date(`${month}-01`, { month: 'short', year: 'numeric' });
  }

  protected tooltip(m: DashboardResponse['months'][number]): string {
    return [this.monthLabel(m.month), ...this.destinations().map((d) => `${this.taxonomy.label('destination', d)}: ${m[d]}`)].join('\n');
  }
}
