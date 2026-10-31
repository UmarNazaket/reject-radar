import { httpResource } from '@angular/common/http';
import { Component, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import type { AdminOrgsResponse } from '@rejectradar/contracts';
import { apiUrl } from '../core/api';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { adminError, adminTime } from './admin-format';

/** Accounts, newest first, or those whose name or a member's email contains the search. */
@Component({
  selector: 'app-admin-accounts',
  imports: [FormsModule, RouterLink, MatButtonModule, Alert],
  template: `
    <form class="flex flex-wrap items-end gap-2 text-sm" (ngSubmit)="search()">
      <label>Account name or member email<input name="q" maxlength="200" class="admin-control w-80" [(ngModel)]="text" /></label>
      <button matButton="outlined" type="submit">Search</button>
    </form>
    @if (list.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (list.hasValue()) {
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-slate-600">
            <tr class="border-b border-slate-200">
              <th scope="col" class="py-2 pe-4 text-start font-medium">Account</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Plan</th>
              <th scope="col" class="py-2 pe-4 text-end font-medium">Members</th>
              <th scope="col" class="py-2 text-start font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            @for (o of list.value().items; track o.id) {
              <tr class="border-b border-slate-100">
                <td class="py-2 pe-4">
                  <a [routerLink]="['/admin/accounts', o.id]" class="text-sky-700 underline"><bdi>{{ o.name }}</bdi></a>
                </td>
                <td class="py-2 pe-4">
                  <span class="capitalize">{{ o.plan }}</span>{{ o.source === 'override' ? ' (granted)' : '' }}
                  @if (o.deactivatedAt) {
                    <span class="ms-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">Deactivated</span>
                  }
                </td>
                <td class="py-2 pe-4 text-end">{{ o.members }}</td>
                <td class="py-2 whitespace-nowrap">{{ time(o.createdAt) }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="4" class="py-4 text-slate-600">No accounts match.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <p class="mt-2 text-sm text-slate-600">Up to 50 accounts, newest first.</p>
    } @else {
      <p class="mt-4 text-slate-600">Loading…</p>
    }
  `,
})
export class AdminAccounts {
  private readonly i18n = inject(I18n);
  private readonly router = inject(Router);
  protected readonly time = adminTime;

  /** `?q=`. */
  readonly q = input<string>();
  protected readonly text = linkedSignal(() => this.q() ?? '');
  protected readonly list = httpResource<AdminOrgsResponse>(() => {
    const q = this.q();
    const params: Record<string, string> = q ? { q } : {};
    return { url: apiUrl('/v1/admin/orgs'), params };
  });

  protected errorText(error: unknown): string {
    return adminError(this.i18n, error);
  }

  protected search(): void {
    void this.router.navigate([], { queryParams: { q: this.text().trim() || null } });
  }
}
