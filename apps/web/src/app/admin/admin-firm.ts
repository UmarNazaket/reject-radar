import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule, type NgForm } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { Router, RouterLink } from '@angular/router';
import type { AdminFirmRecord, AdminFirmResponse, FirmChangeResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { AdminFirmCard } from './admin-firm-card';
import { adminError, RECORD_SOURCE_LABELS } from './admin-format';

const recordId = (r: Pick<AdminFirmRecord, 'source' | 'key'>): string => `${r.source} ${r.key}`;

/** A firm's records, to split some of them to a new firm, and a merge with another firm. Without an id, just the lookup. */
@Component({
  selector: 'app-admin-firm',
  imports: [FormsModule, RouterLink, MatButtonModule, MatCheckboxModule, Alert, AdminFirmCard],
  template: `
    <form class="flex flex-wrap items-end gap-2 text-sm" (ngSubmit)="open()">
      <label>Firm id<input name="openId" type="number" min="1" required class="admin-control w-32" [(ngModel)]="openId" /></label>
      <button matButton="outlined" type="submit">Open firm</button>
    </form>
    @if (action.error(); as error) {
      <app-alert class="mt-4 block">{{ error }}</app-alert>
    }
    @if (done(); as d) {
      <app-alert kind="success" class="mt-4 block"
        >{{ d.text }}
        @if (d.firmId) {
          <a [routerLink]="['/admin/firms', d.firmId]" class="underline">Open firm #{{ d.firmId }}</a>
        }
      </app-alert>
    }
    @if (firm.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (firm.hasValue()) {
      @let f = firm.value().firm;
      @let records = firm.value().records;
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <app-admin-firm-card [firm]="f" heading="Firm" />
        @if (f.mergedInto === null) {
          <form #mergeForm="ngForm" class="rounded border border-slate-200 p-3 text-sm" (ngSubmit)="merge(mergeForm)">
            <h3 class="text-slate-600">Merge with another firm</h3>
            <p class="mt-1 text-slate-600">The older firm, the smaller id, is kept and takes every record, watchlist item and alert of the other.</p>
            <div class="mt-2 flex flex-wrap items-end gap-2">
              <label>Other firm id<input name="mergeId" type="number" min="1" required class="admin-control w-32" [(ngModel)]="mergeId" /></label>
              <button matButton="filled" type="submit" [disabled]="action.busy() || !mergeId">Merge</button>
            </div>
          </form>
        }
      </div>
      <h2 class="mt-6 font-medium">Records ({{ records.length }})</h2>
      @if (f.mergedInto === null && records.length > 1) {
        <div class="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <button matButton="outlined" type="button" [disabled]="action.busy() || selected().size === 0 || selected().size === records.length" (click)="split()">
            Move {{ selected().size }} selected to a new firm
          </button>
          <span class="text-slate-600">Every refusal of an FEI moves together, and at least one record stays.</span>
        </div>
      }
      <div class="mt-2 overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-slate-600">
            <tr class="border-b border-slate-200">
              <th scope="col" class="py-2 pe-2 text-start font-medium"><span class="sr-only">Selected</span></th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Record</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Date</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Name as written</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Address as written</th>
              <th scope="col" class="py-2 text-start font-medium">FEI</th>
            </tr>
          </thead>
          <tbody>
            @for (r of records; track recordId(r)) {
              <tr class="border-b border-slate-100 align-top">
                <td class="pe-2">
                  <mat-checkbox
                    [checked]="selected().has(recordId(r))"
                    [disabled]="f.mergedInto !== null"
                    (change)="toggle(r, $event.checked)"
                    [aria-label]="'Select ' + recordId(r)"
                  />
                </td>
                <td class="py-2 pe-4">{{ sources[r.source] }} <span class="text-slate-600">{{ r.key }}</span></td>
                <td class="py-2 pe-4 whitespace-nowrap">{{ r.seenOn }}</td>
                <td class="py-2 pe-4" dir="auto">{{ r.firmName }}</td>
                <td class="py-2 pe-4 break-words" dir="auto">{{ r.address ?? '' }}</td>
                <td class="py-2">{{ r.fei ?? '' }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="py-4 text-slate-600">No records.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else if (firmId() !== null) {
      <p class="mt-4 text-slate-600">Loading…</p>
    }
  `,
})
export class AdminFirm {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly sources = RECORD_SOURCE_LABELS;
  protected readonly recordId = recordId;

  /** The `:id` path parameter; none on `/admin/firms`. */
  readonly id = input<string>();
  protected readonly firmId = computed(() => (/^[1-9]\d{0,14}$/.test(this.id() ?? '') ? Number(this.id()) : null));
  protected readonly firm = httpResource<AdminFirmResponse>(() => {
    const id = this.firmId();
    return id === null ? undefined : apiUrl(`/v1/admin/firms/${id}`);
  });
  /** The records ticked to split; cleared whenever the firm (re)loads. */
  protected readonly selected = linkedSignal<AdminFirmResponse | undefined, ReadonlySet<string>>({
    source: () => (this.firm.hasValue() ? this.firm.value() : undefined),
    computation: () => new Set(),
  });
  protected readonly action = new FormState(this.i18n, adminError);
  /** What the last split or merge did; cleared when another firm opens. */
  protected readonly done = linkedSignal<string | undefined, { text: string; firmId?: number } | null>({ source: this.id, computation: () => null });
  protected openId: number | null = null;
  protected mergeId: number | null = null;

  protected errorText(error: unknown): string {
    return adminError(this.i18n, error);
  }

  protected open(): void {
    if (this.openId && Number.isInteger(this.openId) && this.openId > 0) void this.router.navigate(['/admin/firms', this.openId]);
  }

  protected toggle(record: AdminFirmRecord, checked: boolean): void {
    this.selected.update((ids) => {
      const next = new Set(ids);
      if (checked) next.add(recordId(record));
      else next.delete(recordId(record));
      return next;
    });
  }

  protected split(): void {
    const id = this.firmId();
    const records = (this.firm.hasValue() ? this.firm.value().records : []).filter((r) => this.selected().has(recordId(r)));
    const count = `${records.length} ${records.length === 1 ? 'record' : 'records'}`;
    if (id === null || !confirm(`Move ${count} of firm #${id} to a new firm?`)) return;
    void this.action.run(async () => {
      const result = await firstValueFrom(
        this.http.post<FirmChangeResponse>(apiUrl(`/v1/admin/firms/${id}/split`), { records: records.map(({ source, key }) => ({ source, key })) }),
      );
      this.done.set({ text: `Moved ${count} to a new firm.`, firmId: result.otherId });
      this.firm.reload();
    });
  }

  protected merge(form: NgForm): void {
    const id = this.firmId();
    const other = this.mergeId;
    if (id === null || !other || !confirm(`Merge firm #${id} and firm #${other}? This cannot be undone here; a split can move records back.`)) return;
    void this.action.run(async () => {
      const result = await firstValueFrom(this.http.post<FirmChangeResponse>(apiUrl('/v1/admin/firms/merge'), { firmIds: [id, other] }));
      form.resetForm();
      if (result.keptId === id) this.firm.reload();
      else await this.router.navigate(['/admin/firms', result.keptId]);
      this.done.set({ text: `Merged firm #${result.otherId} into firm #${result.keptId}.` });
    });
  }
}
