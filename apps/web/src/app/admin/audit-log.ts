import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import type { AuditEntry, AuditResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { adminError, adminTime } from './admin-format';

/** The admin pages a target type has, to open the target from its entry. */
const TARGET_PAGES: Record<string, string> = { firm: '/admin/firms', org: '/admin/accounts' };

/** Who changed what, newest first: staff actions, merges and splits, and the remaps the sync job ran. */
@Component({
  selector: 'app-admin-audit-log',
  imports: [FormsModule, RouterLink, MatButtonModule, Alert],
  template: `
    <form class="flex flex-wrap items-end gap-2 text-sm" (ngSubmit)="filter()">
      <label>Action starts with<input name="action" maxlength="100" placeholder="firm." class="admin-control w-60" [(ngModel)]="text" /></label>
      <button matButton="outlined" type="submit">Filter</button>
    </form>
    @if (more.error(); as error) {
      <app-alert class="mt-4 block">{{ error }}</app-alert>
    }
    @if (first.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (first.hasValue()) {
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-slate-600">
            <tr class="border-b border-slate-200">
              <th scope="col" class="py-2 pe-4 text-start font-medium">When</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Who</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Action</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Target</th>
              <th scope="col" class="py-2 text-start font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            @for (e of items(); track e.id) {
              <tr class="border-b border-slate-100 align-top">
                <td class="py-2 pe-4 whitespace-nowrap">{{ time(e.at) }}</td>
                <td class="py-2 pe-4">{{ e.actor ? e.actor.name + ' (' + e.actor.email + ')' : 'System' }}</td>
                <td class="py-2 pe-4 whitespace-nowrap">{{ e.action }}</td>
                <td class="py-2 pe-4 whitespace-nowrap">
                  @if (pageOf(e); as page) {
                    <a [routerLink]="[page, e.targetId]" class="text-sky-700 underline">{{ e.targetType }} {{ e.targetId }}</a>
                  } @else {
                    {{ e.targetType }} {{ e.targetId }}
                  }
                </td>
                <td class="py-2 font-mono text-xs break-all">{{ json(e.details) }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="py-4 text-slate-600">No entries.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (next() !== null) {
        <button matButton="outlined" type="button" class="mt-3" [disabled]="more.busy()" (click)="loadMore()">Show more</button>
      }
    } @else {
      <p class="mt-4 text-slate-600">Loading…</p>
    }
  `,
})
export class AdminAuditLog {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly time = adminTime;

  /** `?action=`. */
  readonly action = input<string>();
  protected readonly text = linkedSignal(() => this.action() ?? '');
  private readonly params = computed((): Record<string, string> => {
    const action = this.action();
    return action ? { action } : {};
  });
  protected readonly first = httpResource<AuditResponse>(() => ({ url: apiUrl('/v1/admin/audit'), params: this.params() }));
  /** The pages shown: the first one, then those "Show more" added; a new first page starts over. */
  private readonly pages = linkedSignal<AuditResponse | undefined, AuditResponse[]>({
    source: () => (this.first.hasValue() ? this.first.value() : undefined),
    computation: (first) => (first ? [first] : []),
  });
  protected readonly items = computed(() => this.pages().flatMap((page) => page.items));
  protected readonly next = computed(() => {
    const pages = this.pages();
    return pages.length > 0 ? pages[pages.length - 1].next : null;
  });
  protected readonly more = new FormState(this.i18n, adminError);

  protected errorText(error: unknown): string {
    return adminError(this.i18n, error);
  }

  protected json(details: Record<string, unknown>): string {
    return JSON.stringify(details);
  }

  protected pageOf(entry: AuditEntry): string | null {
    return TARGET_PAGES[entry.targetType] ?? null;
  }

  protected filter(): void {
    void this.router.navigate([], { queryParams: { action: this.text().trim() || null } });
  }

  protected loadMore(): void {
    const cursor = this.next();
    const first = this.pages()[0];
    if (cursor === null) return;
    void this.more.run(async () => {
      const page = await firstValueFrom(this.http.get<AuditResponse>(apiUrl('/v1/admin/audit'), { params: { ...this.params(), cursor } }));
      // A filter changed while the page loaded: it belongs to the old list.
      if (this.pages()[0] === first) this.pages.update((pages) => [...pages, page]);
    });
  }
}
