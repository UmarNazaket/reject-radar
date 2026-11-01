import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { CheckoutResponse, PlansResponse, PortalResponse, SubscriptionResponse } from '@rejectradar/contracts';
import { type PlanId, PLANS } from '@rejectradar/contracts/plans';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { openCheckout } from '../core/paddle';
import { Alert } from '../layout/alert';

const PAID_STATUSES = ['active', 'trialing', 'past_due'];
const POLL_MS = 3000;
const POLL_TRIES = 20;

/** The account's plan, this month's usage against its limits, and for owners Paddle checkout and the customer portal. */
@Component({
  selector: 'app-billing',
  imports: [MatButtonModule, Alert],
  template: `
    @if (checkout() === 'success') {
      <app-alert kind="success" class="mb-4 block">{{ i18n.t(paid() ? 'web.billing.thanks' : waiting() ? 'web.billing.thanksWaiting' : 'web.billing.thanksSlow') }}</app-alert>
    }
    @if (action.error(); as error) {
      <app-alert class="mb-4 block">{{ error }}</app-alert>
    }
    @if (subscription.error(); as error) {
      <app-alert>{{ errorText(error) }}</app-alert>
    } @else if (subscription.hasValue()) {
      @let s = subscription.value();
      <section class="max-w-2xl rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="font-medium">{{ i18n.t('web.billing.plan', { plan: planName(s.plan) }) }}</h2>
        <p class="mt-1 text-sm text-slate-600">
          {{ i18n.t('web.billing.source.' + s.source) }}
          @if (s.status) {
            · {{ i18n.t('web.billing.statuses.' + s.status) }}
          }
          @if (s.interval) {
            · {{ i18n.t('web.billing.interval.' + s.interval) }}
          }
          @if (s.cancelAt) {
            · {{ i18n.t('web.billing.cancelAt', { date: i18n.date(s.cancelAt) }) }}
          } @else if (s.currentPeriodEnd) {
            · {{ i18n.t('web.billing.renews', { date: i18n.date(s.currentPeriodEnd) }) }}
          }
        </p>
        @if (s.status === 'past_due') {
          <app-alert kind="warn" class="mt-3 block">{{ i18n.t('web.billing.pastDue') }}</app-alert>
        }

        <h3 class="mt-4 text-sm font-medium text-slate-700">{{ i18n.t('web.billing.usage', { period: s.usage.period }) }}</h3>
        <dl class="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          @for (u of usage(s); track u.key) {
            <div class="rounded border border-slate-100 p-2">
              <dt class="text-slate-600">{{ i18n.t(u.key) }}</dt>
              <dd class="font-medium">{{ i18n.number(u.used) }} / {{ i18n.number(u.limit) }}</dd>
            </div>
          }
        </dl>

        @if (s.canManage && paid()) {
          <button matButton="filled" type="button" class="mt-4" [disabled]="action.busy()" (click)="portal()">{{ i18n.t('web.billing.manage') }}</button>
        } @else if (!s.canManage) {
          <p class="mt-4 text-sm text-slate-600">{{ i18n.t('web.billing.ownerOnly') }}</p>
        } @else if (s.hasBillingAccount) {
          <button matButton type="button" class="mt-4" [disabled]="action.busy()" (click)="portal()">{{ i18n.t('web.billing.invoices') }}</button>
        }
      </section>

      @if (s.canManage && !paid() && s.source !== 'override' && plans.hasValue()) {
        <section class="mt-6 grid max-w-2xl gap-4 sm:grid-cols-2">
          @for (p of paidPlans(); track p.id) {
            <div class="rounded-lg border border-slate-200 bg-white p-4">
              <h3 class="font-medium">{{ p.name }}</h3>
              <p class="mt-1 text-sm text-slate-600">{{ i18n.t('web.pricing.perMonth', { price: p.monthlyPriceUsd ?? 0 }) }} · {{ i18n.t('web.pricing.perYear', { price: p.yearlyPriceUsd ?? 0 }) }}</p>
              <div class="mt-3 flex flex-wrap gap-2">
                <button matButton="filled" type="button" [disabled]="action.busy()" (click)="buy(p.id, 'month')">{{ i18n.t('web.billing.buyMonthly') }}</button>
                <button matButton="outlined" type="button" [disabled]="action.busy()" (click)="buy(p.id, 'year')">{{ i18n.t('web.billing.buyYearly') }}</button>
              </div>
            </div>
          }
        </section>
      }
    } @else {
      <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class Billing {
  protected readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  /** `?checkout=success`: Paddle sent the buyer back; the plan changes once its webhook lands. */
  readonly checkout = input<string>();

  protected readonly subscription = httpResource<SubscriptionResponse>(() => apiUrl('/v1/billing/subscription'));
  protected readonly plans = httpResource<PlansResponse>(() => apiUrl('/v1/billing/plans'));
  protected readonly paid = computed(() => this.subscription.hasValue() && PAID_STATUSES.includes(this.subscription.value().status ?? ''));
  protected readonly paidPlans = computed(() => (this.plans.hasValue() ? this.plans.value().plans.filter((p) => p.prices) : []));
  protected readonly action = new FormState(this.i18n);
  private readonly tries = signal(0);
  /** True while the page still waits for Paddle's webhook after a checkout. */
  protected readonly waiting = computed(() => this.checkout() === 'success' && !this.paid() && this.tries() < POLL_TRIES);

  constructor() {
    const timer = setInterval(() => {
      if (!this.waiting() || this.subscription.isLoading()) return;
      this.tries.update((n) => n + 1);
      this.subscription.reload();
    }, POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  /** From the shared plan table, so the name shows before the price list loads. */
  protected planName(id: PlanId): string {
    return PLANS[id].name;
  }

  /** This month's usage next to each limit; a limit of 0 means the plan does not include it. */
  protected usage(s: SubscriptionResponse): { key: string; used: number; limit: number }[] {
    return [
      { key: 'web.billing.lookups', used: s.usage.lookups, limit: s.limits.lookupsPerMonth },
      { key: 'web.billing.watchlist', used: s.usage.watchlist, limit: s.limits.watchlistSize },
      { key: 'web.billing.members', used: s.usage.seats, limit: s.limits.members },
      { key: 'web.billing.bulkRows', used: s.usage.bulkRows, limit: s.limits.bulkRowsPerMonth },
      { key: 'web.billing.apiCalls', used: s.usage.apiCalls, limit: s.limits.apiCallsPerMonth },
    ];
  }

  protected buy(plan: string, interval: 'month' | 'year'): void {
    void this.action.run(async () => {
      await openCheckout(await firstValueFrom(this.http.post<CheckoutResponse>(apiUrl('/v1/billing/checkout'), { plan, interval })));
    });
  }

  protected portal(): void {
    void this.action.run(async () => {
      const { url } = await firstValueFrom(this.http.post<PortalResponse>(apiUrl('/v1/billing/portal'), {}));
      location.assign(url);
    });
  }
}
