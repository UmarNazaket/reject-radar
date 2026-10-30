import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminFirmSummary } from '@rejectradar/contracts';

/** A firm, with enough to tell it from another: place, FEIs, record count, and where it was merged. */
@Component({
  selector: 'app-admin-firm-card',
  imports: [RouterLink],
  template: `
    @let f = firm();
    <section class="rounded border border-slate-200 p-3 text-sm">
      <h3 class="text-slate-600">{{ heading() }}</h3>
      <a [routerLink]="['/admin/firms', f.id]" class="mt-1 block font-medium text-sky-700 underline"
        ><bdi>{{ f.displayName }}</bdi> (#{{ f.id }})</a
      >
      <p class="mt-1 text-slate-700">{{ place() }}</p>
      <p class="mt-1 text-slate-700">FEI: {{ f.feis.length > 0 ? f.feis.join(', ') : 'none' }} · {{ f.records }} {{ f.records === 1 ? 'record' : 'records' }}</p>
      @if (f.mergedInto !== null) {
        <p class="mt-1 text-amber-900">Merged into firm #{{ f.mergedInto }}</p>
      }
    </section>
  `,
})
export class AdminFirmCard {
  readonly firm = input.required<AdminFirmSummary>();
  readonly heading = input.required<string>();

  protected readonly place = computed(() => [this.firm().city, this.firm().countryCode].filter(Boolean).join(', ') || 'No address');
}
