import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import type { DashboardResponse, Destination } from '@rejectradar/contracts';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { DataDates } from '../layout/data-dates';
import { NoticeTable } from '../notices/notice-table';
import { DESTINATION_COLORS, MonthChart } from './month-chart';

/** The topic dashboard's blocks: totals, notices per month, main hazards, commodities, latest notices and data dates. */
@Component({
  selector: 'app-topic-dashboard',
  imports: [MonthChart, NgTemplateOutlet, NoticeTable, DataDates],
  template: `
    @let data = dashboard();
    @if (data.historyFrom) {
      <p class="text-sm text-slate-600">{{ i18n.t('web.topics.historyFrom', { date: i18n.date(data.historyFrom) }) }}</p>
    }
    @if (empty()) {
      <p class="mt-4 rounded-lg border border-slate-200 bg-white p-6 text-slate-600">{{ i18n.t('web.topics.noNotices') }}</p>
    } @else {
      <section class="mt-4">
        <h2 class="text-sm font-medium text-slate-600">{{ i18n.t('web.topics.totals') }}</h2>
        <dl class="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          @for (d of destinations(); track d) {
            <div class="rounded-lg border border-slate-200 bg-white p-4">
              <dt class="flex items-center gap-1.5 text-sm text-slate-600"><span class="size-3 rounded-sm" [style.background]="colors[d]"></span>{{ taxonomy.label('destination', d) }}</dt>
              <dd class="mt-1 text-2xl font-semibold text-slate-900">{{ data.totals12m[d] }}</dd>
            </div>
          }
        </dl>
      </section>

      <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.topics.monthly') }}</h2>
        <app-month-chart [months]="data.months" [destinations]="destinations()" [caption]="i18n.t('web.topics.monthly')" />
      </section>

      <div class="mt-6 grid gap-6 lg:grid-cols-2">
        <section class="rounded-lg border border-slate-200 bg-white p-4">
          <h2 class="mb-3 font-medium">{{ i18n.t('web.topics.categories') }}</h2>
          <ng-container *ngTemplateOutlet="bars; context: { $implicit: categoryBars() }" />
        </section>
        <section class="rounded-lg border border-slate-200 bg-white p-4">
          <h2 class="mb-3 font-medium">{{ i18n.t('web.topics.commodities') }}</h2>
          <ng-container *ngTemplateOutlet="bars; context: { $implicit: commodityBars() }" />
        </section>
      </div>

      <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.topics.findings') }}</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-slate-600">
              <tr class="border-b border-slate-200">
                <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.topics.hazard') }}</th>
                <th scope="col" class="px-2 py-2 text-end font-medium">{{ i18n.t('web.topics.total') }}</th>
                @for (d of destinations(); track d) {
                  <th scope="col" class="px-2 py-2 text-end font-medium">{{ d }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (f of data.findings; track f.hazardId) {
                <tr class="border-b border-slate-100">
                  <th scope="row" class="py-2 pe-4 text-start font-normal">{{ taxonomy.label('hazard', f.hazardId) }}</th>
                  <td class="px-2 py-2 text-end font-medium">{{ f.count }}</td>
                  @for (d of destinations(); track d) {
                    <td class="px-2 py-2 text-end text-slate-600">{{ f.byDestination[d] }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.topics.latest') }}</h2>
        <app-notice-table [notices]="data.latest" [showOrigin]="false" />
      </section>
    }

    <app-data-dates [freshness]="data.freshness" />

    <ng-template #bars let-rows>
      @if (rows.length === 0) {
        <p class="text-sm text-slate-600">{{ i18n.t('web.topics.none') }}</p>
      }
      <ul class="flex flex-col gap-2 text-sm">
        @for (row of rows; track row.label) {
          <li>
            <div class="flex justify-between gap-2"><span>{{ row.label }}</span><span class="font-medium">{{ row.count }}</span></div>
            <div class="mt-1 h-2 rounded bg-slate-100"><div class="h-2 rounded bg-[#2a78d6]" [style.width.%]="row.width"></div></div>
          </li>
        }
      </ul>
    </ng-template>
  `,
})
export class TopicDashboard {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  readonly dashboard = input.required<DashboardResponse>();
  /** The destinations chosen, or all of them. */
  readonly destinations = input.required<Destination[]>();
  protected readonly colors = DESTINATION_COLORS;

  protected readonly empty = computed(() => {
    const data = this.dashboard();
    return data.latest.length === 0 && data.months.every((m) => this.destinations().every((d) => m[d] === 0));
  });
  protected readonly categoryBars = computed(() => this.bars(this.dashboard().hazardCategories.map((c) => ({ label: this.taxonomy.label('hazardCategory', c.category), count: c.count }))));
  protected readonly commodityBars = computed(() => this.bars(this.dashboard().commodities.map((c) => ({ label: this.taxonomy.label('commodity', c.commodityId), count: c.count }))));

  /** Rows for a bar list, each bar as wide as its share of the largest count. */
  private bars(rows: { label: string; count: number }[]): { label: string; count: number; width: number }[] {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return rows.map((r) => ({ ...r, width: (r.count / max) * 100 }));
  }
}
