import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import type { AdminUsersResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { adminError, adminTime } from './admin-format';

/** People across every account, newest first, with the accounts they belong to. Read-only. */
@Component({
  selector: 'app-admin-users',
  imports: [FormsModule, RouterLink, MatButtonModule, Alert],
  template: `
    <form class="flex flex-wrap items-end gap-2 text-sm" (ngSubmit)="filter()">
      <label>Email or name contains<input name="q" maxlength="200" placeholder="name@example.com" class="admin-control w-72" [(ngModel)]="text" /></label>
      <button matButton="outlined" type="submit">Find</button>
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
              <th scope="col" class="py-2 pe-4 text-start font-medium">Person</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Accounts</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Status</th>
              <th scope="col" class="py-2 text-start font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            @for (u of items(); track u.id) {
              <tr class="border-b border-slate-100 align-top">
                <td class="py-2 pe-4">
                  <bdi>{{ u.name }}</bdi>
                  <div class="break-all text-slate-600">{{ u.email }}</div>
                </td>
                <td class="py-2 pe-4">
                  @for (a of u.accounts; track a.id) {
                    <div>
                      <a [routerLink]="['/admin/accounts', a.id]" class="text-sky-700 underline"><bdi>{{ a.name }}</bdi></a> ({{ a.role }})
                    </div>
                  } @empty {
                    <span class="text-slate-600">None</span>
                  }
                </td>
                <td class="py-2 pe-4">
                  <div class="flex flex-wrap gap-1">
                    <span class="rounded px-1.5 py-0.5 text-xs" [class]="u.verified ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-800'">{{
                      u.verified ? 'Verified' : 'Not verified'
                    }}</span>
                    @if (u.isPlatformAdmin) {
                      <span class="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-800">Staff</span>
                    }
                    @if (u.lockedUntil) {
                      <span class="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">Locked until {{ time(u.lockedUntil) }}</span>
                    }
                  </div>
                </td>
                <td class="py-2 whitespace-nowrap">{{ time(u.createdAt) }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="4" class="py-4 text-slate-600">No people.</td>
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
export class AdminUsers {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly time = adminTime;

  /** `?q=`. */
  readonly q = input<string>();
  protected readonly text = linkedSignal(() => this.q() ?? '');
  private readonly params = computed((): Record<string, string> => {
    const q = this.q();
    return q ? { q } : {};
  });
  protected readonly first = httpResource<AdminUsersResponse>(() => ({ url: apiUrl('/v1/admin/users'), params: this.params() }));
  /** The pages shown: the first one, then those "Show more" added; a new first page starts over. */
  private readonly pages = linkedSignal<AdminUsersResponse | undefined, AdminUsersResponse[]>({
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
    void this.router.navigate([], { queryParams: { q: this.text().trim() || null } });
  }

  protected loadMore(): void {
    const cursor = this.next();
    const first = this.pages()[0];
    if (cursor === null) return;
    void this.more.run(async () => {
      const page = await firstValueFrom(this.http.get<AdminUsersResponse>(apiUrl('/v1/admin/users'), { params: { ...this.params(), cursor } }));
      // A search changed while the page loaded: it belongs to the old list.
      if (this.pages()[0] === first) this.pages.update((pages) => [...pages, page]);
    });
  }
}
