import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Router } from '@angular/router';
import type { EmailDeliveryStatus, EmailLogResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { adminError, adminTime } from './admin-format';

/** Failed and paused sends stand out; `paused` means the daily cap held the email back. */
const STATUS_STYLES: Record<EmailDeliveryStatus, string> = {
  sending: 'bg-slate-100 text-slate-800',
  sent: 'bg-emerald-50 text-emerald-800',
  failed: 'bg-red-50 text-red-800',
  paused: 'bg-amber-100 text-amber-900',
};

/** Every email the product sent or tried to send, newest first, to answer "I never got the email". */
@Component({
  selector: 'app-admin-email-log',
  imports: [FormsModule, MatButtonModule, Alert],
  template: `
    <form class="flex flex-wrap items-end gap-2 text-sm" (ngSubmit)="filter()">
      <label>Recipient contains<input name="to" maxlength="200" placeholder="name@example.com" class="admin-control w-72" [(ngModel)]="text" /></label>
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
              <th scope="col" class="py-2 pe-4 text-start font-medium">To</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Kind</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Status</th>
              <th scope="col" class="py-2 text-start font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            @for (e of items(); track e.id) {
              <tr class="border-b border-slate-100 align-top">
                <td class="py-2 pe-4 whitespace-nowrap">{{ time(e.at) }}</td>
                <td class="py-2 pe-4 break-all">{{ e.to }}</td>
                <td class="py-2 pe-4 whitespace-nowrap">{{ e.kind }}</td>
                <td class="py-2 pe-4">
                  <span class="rounded px-1.5 py-0.5 text-xs" [class]="statusStyles[e.status]">{{ e.status }}</span>
                </td>
                <td class="py-2 font-mono text-xs break-all">{{ e.error ?? '' }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5" class="py-4 text-slate-600">No emails.</td>
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
export class AdminEmailLog {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly time = adminTime;
  protected readonly statusStyles = STATUS_STYLES;

  /** `?to=`. */
  readonly to = input<string>();
  protected readonly text = linkedSignal(() => this.to() ?? '');
  private readonly params = computed((): Record<string, string> => {
    const to = this.to();
    return to ? { to } : {};
  });
  protected readonly first = httpResource<EmailLogResponse>(() => ({ url: apiUrl('/v1/admin/emails'), params: this.params() }));
  /** The pages shown: the first one, then those "Show more" added; a new first page starts over. */
  private readonly pages = linkedSignal<EmailLogResponse | undefined, EmailLogResponse[]>({
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

  protected filter(): void {
    void this.router.navigate([], { queryParams: { to: this.text().trim() || null } });
  }

  protected loadMore(): void {
    const cursor = this.next();
    const first = this.pages()[0];
    if (cursor === null) return;
    void this.more.run(async () => {
      const page = await firstValueFrom(this.http.get<EmailLogResponse>(apiUrl('/v1/admin/emails'), { params: { ...this.params(), cursor } }));
      // A filter changed while the page loaded: it belongs to the old list.
      if (this.pages()[0] === first) this.pages.update((pages) => [...pages, page]);
    });
  }
}
