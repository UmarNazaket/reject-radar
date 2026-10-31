import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { type AdminOrgResponse, PLAN_IDS, type PlanId } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { adminError, adminTime } from './admin-format';

const SOURCE_LABELS = { override: 'granted by staff', subscription: 'paid subscription', free: 'no subscription' } as const;

/** One account: its plan and where it comes from, this month's usage against the limits, its members, and the plan override. */
@Component({
  selector: 'app-admin-account',
  imports: [FormsModule, RouterLink, MatButtonModule, Alert],
  template: `
    <a routerLink="/admin/accounts" class="text-sm text-sky-700 underline">All accounts</a>
    @if (action.error(); as error) {
      <app-alert class="mt-4 block">{{ error }}</app-alert>
    }
    @if (done(); as text) {
      <app-alert kind="success" class="mt-4 block">{{ text }}</app-alert>
    }
    @if (account.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (account.hasValue()) {
      @let a = account.value();
      <h2 class="mt-3 text-xl font-semibold"><bdi>{{ a.org.name }}</bdi></h2>
      <p class="mt-1 text-sm text-slate-600">Created {{ time(a.org.createdAt) }} · {{ a.org.id }}</p>
      @if (a.org.deactivatedAt) {
        <app-alert kind="warn" class="mt-3 block"
          >Deactivated {{ time(a.org.deactivatedAt) }}: its members cannot sign in, its API keys are refused and no alert emails go out.</app-alert
        >
      }

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <section class="rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <h3 class="font-medium">Plan</h3>
          <p class="mt-1"><span class="capitalize">{{ a.plan }}</span>, {{ sources[a.source] }}</p>
          @if (a.subscription; as s) {
            <p class="mt-1 text-slate-600">
              Paddle: {{ s.status }}{{ s.interval ? ', every ' + s.interval : '' }}{{ s.currentPeriodEnd ? ', period ends ' + time(s.currentPeriodEnd) : '' }}{{
                s.cancelAt ? ', cancels ' + time(s.cancelAt) : ''
              }}
            </p>
          }
          <form class="mt-3 flex flex-wrap items-end gap-2" (ngSubmit)="saveOverride(a)">
            <label
              >Plan override
              <select name="override" class="admin-control" [(ngModel)]="override">
                <option [ngValue]="null">None</option>
                @for (p of plans; track p) {
                  <option [ngValue]="p">{{ p }}</option>
                }
              </select>
            </label>
            <button matButton="filled" type="submit" [disabled]="action.busy() || override() === a.org.planOverride">Save</button>
          </form>
          <p class="mt-1 text-slate-600">An override wins over any subscription, and Paddle keeps billing a subscription as before.</p>
        </section>

        <section class="rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <h3 class="font-medium">Usage in {{ a.usage.period }}</h3>
          <dl class="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
            @for (u of usage(); track u.label) {
              <dt class="text-slate-600">{{ u.label }}</dt>
              <dd class="text-end">{{ u.used }} of {{ u.limit }}</dd>
            }
          </dl>
        </section>
      </div>

      <section class="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <h3 class="font-medium">Account status</h3>
        <p class="mt-1 text-slate-600">{{ a.org.deactivatedAt ? 'Deactivated.' : 'Active.' }} Deactivating keeps the account's data, so it can be reactivated.</p>
        @if (a.org.deactivatedAt) {
          <button matButton="outlined" type="button" class="mt-2" [disabled]="action.busy()" (click)="setActive(a, true)">Reactivate</button>
        } @else {
          <button matButton="outlined" type="button" class="mt-2" [disabled]="action.busy()" (click)="setActive(a, false)">Deactivate</button>
        }
      </section>

      <h3 class="mt-6 font-medium">Members ({{ a.members.length }})</h3>
      <div class="mt-2 overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-slate-600">
            <tr class="border-b border-slate-200">
              <th scope="col" class="py-2 pe-4 text-start font-medium">Name</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Email</th>
              <th scope="col" class="py-2 pe-4 text-start font-medium">Role</th>
              <th scope="col" class="py-2 text-start font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            @for (m of a.members; track m.userId) {
              <tr class="border-b border-slate-100">
                <td class="py-2 pe-4"><bdi>{{ m.name }}</bdi></td>
                <td class="py-2 pe-4">{{ m.email }}{{ m.emailVerified ? '' : ' (not verified)' }}</td>
                <td class="py-2 pe-4 capitalize">{{ m.role }}</td>
                <td class="py-2 whitespace-nowrap">{{ time(m.joinedAt) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <p class="mt-4 text-slate-600">Loading…</p>
    }
  `,
})
export class AdminAccount {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  protected readonly plans = PLAN_IDS;
  protected readonly sources = SOURCE_LABELS;
  protected readonly time = adminTime;

  /** The `:id` path parameter. */
  readonly id = input.required<string>();
  protected readonly account = httpResource<AdminOrgResponse>(() => apiUrl(`/v1/admin/orgs/${encodeURIComponent(this.id())}`));
  protected readonly action = new FormState(this.i18n, adminError);
  /** What the last save did; cleared when another account opens. */
  protected readonly done = linkedSignal<string, string | null>({ source: this.id, computation: () => null });
  /** The override chosen in the form: the stored one each time the account loads. */
  protected readonly override = linkedSignal<PlanId | null>(() => (this.account.hasValue() ? this.account.value().org.planOverride : null));

  protected readonly usage = computed(() => {
    if (!this.account.hasValue()) return [];
    const { usage, limits } = this.account.value();
    return [
      { label: 'Firm lookups', used: usage.lookups, limit: limits.lookupsPerMonth },
      { label: 'Bulk rows', used: usage.bulkRows, limit: limits.bulkRowsPerMonth },
      { label: 'API calls', used: usage.apiCalls, limit: limits.apiCallsPerMonth },
      { label: 'Watchlist items', used: usage.watchlist, limit: limits.watchlistSize },
      { label: 'Seats (members and invites)', used: usage.seats, limit: limits.members },
    ];
  });

  protected errorText(error: unknown): string {
    return adminError(this.i18n, error);
  }

  protected setActive(account: AdminOrgResponse, active: boolean): void {
    const question = active
      ? `Reactivate ${account.org.name}? Its members can sign in again.`
      : `Deactivate ${account.org.name}? Its members are signed out, its API keys stop working and its alert emails stop. Its data is kept.`;
    if (!confirm(question)) return;
    this.done.set(null);
    void this.action.run(async () => {
      await firstValueFrom(this.http.post<AdminOrgResponse>(apiUrl(`/v1/admin/orgs/${account.org.id}/${active ? 'reactivate' : 'deactivate'}`), {}));
      this.done.set(active ? 'Reactivated the account.' : 'Deactivated the account.');
      this.account.reload();
    });
  }

  protected saveOverride(account: AdminOrgResponse): void {
    const next = this.override();
    const what = next ? `Grant ${account.org.name} the ${next} plan` : `Clear the plan override of ${account.org.name}`;
    if (!confirm(`${what}? Its limits change at once.`)) return;
    this.done.set(null);
    void this.action.run(async () => {
      await firstValueFrom(this.http.patch<AdminOrgResponse>(apiUrl(`/v1/admin/orgs/${account.org.id}`), { planOverride: next }));
      this.done.set(next ? `Granted the ${next} plan.` : 'Cleared the plan override.');
      this.account.reload();
    });
  }
}
