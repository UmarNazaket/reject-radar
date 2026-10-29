import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import type { AlertItem, AlertsResponse, NotificationPrefs } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { AlertCount } from '../core/alert-count';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';

const FILTERS = ['severity', 'unread', 'firm', 'origin', 'commodity', 'destination', 'hazard'] as const;

/** The alerts inbox: newest first, filtered by the URL (a watchlist item links here with its own fields), and the email settings. */
@Component({
  selector: 'app-alert-list',
  imports: [FormsModule, RouterLink, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatSelectModule, Alert],
  template: `
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-2xl font-semibold">{{ i18n.t('web.alerts.title') }}</h1>
      @if (alertCount.unread(); as unread) {
        <span class="text-sm text-slate-600">{{ i18n.t('web.alerts.unreadCount', { count: unread }) }}</span>
        <button matButton type="button" class="ms-auto" [disabled]="marking()" (click)="markAll()">{{ i18n.t('web.alerts.markAll') }}</button>
      }
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-x-6">
      <mat-form-field>
        <mat-label>{{ i18n.t('web.alerts.severity') }}</mat-label>
        <mat-select [value]="severity() ?? null" (selectionChange)="navigate({ severity: $event.value })">
          <mat-option [value]="null">{{ i18n.t('web.notices.any') }}</mat-option>
          <mat-option value="high">{{ i18n.t('web.alerts.high') }}</mat-option>
          <mat-option value="normal">{{ i18n.t('web.alerts.normal') }}</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-checkbox [checked]="unread() === 'true'" (change)="navigate({ unread: $event.checked ? 'true' : null })">{{ i18n.t('web.alerts.unreadOnly') }}</mat-checkbox>
      @if (scoped()) {
        <a routerLink="/alerts" class="text-sm text-sky-700 underline">{{ i18n.t('web.alerts.allAlerts') }}</a>
      }
    </div>

    @if (list.error(); as error) {
      <app-alert>{{ errorText(error) }}</app-alert>
    } @else if (list.hasValue()) {
      @if (actionError(); as error) {
        <app-alert class="mb-4 block">{{ error }}</app-alert>
      }
      <ul class="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        @for (a of items(); track a.id) {
          <li class="flex flex-wrap items-start gap-x-4 gap-y-1 p-4" [class.bg-sky-50]="!a.readAt">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                @if (a.severity === 'high') {
                  <span class="inline-block rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-800">{{ i18n.t('web.alerts.high') }}</span>
                }
                <span class="font-medium">{{ i18n.t('alerts.kind.' + a.kind) }}</span>
                <span class="text-sm text-slate-600">{{ i18n.date(a.occurredOn) }}</span>
                @if (!a.readAt) {
                  <span class="text-xs font-medium text-sky-800">{{ i18n.t('web.alerts.new') }}</span>
                }
              </div>
              <div class="mt-1 text-sm">
                @if (a.firm) {
                  <a [routerLink]="['/firms', a.firm.id]" class="text-sky-700 underline">{{ a.firm.displayName }}</a>
                }
                @if (a.notice; as n) {
                  @if (a.firm) {
                    ·
                  }
                  <a [routerLink]="['/notices', n.id]" class="text-sky-700 underline">{{ n.productText ?? n.title ?? i18n.t('web.notices.notice') }}</a>
                  · {{ taxonomy.label('destination', n.destination) }}
                  @if (n.originCountry) {
                    · {{ taxonomy.label('country', n.originCountry) }}
                  }
                }
              </div>
            </div>
            @if (!a.readAt) {
              <button matButton type="button" [disabled]="marking()" (click)="markRead(a)">{{ i18n.t('web.alerts.markRead') }}</button>
            }
          </li>
        } @empty {
          <li class="p-6 text-slate-600">{{ i18n.t(scoped() ? 'web.alerts.noneHere' : 'web.alerts.none') }}</li>
        }
      </ul>
      @if (next()) {
        <button matButton="outlined" type="button" class="mt-4" [disabled]="loadingMore()" (click)="loadMore()">{{ i18n.t('web.notices.more') }}</button>
      }
    } @else {
      <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
    }

    <section class="mt-8 max-w-xl rounded-lg border border-slate-200 bg-white p-4">
      <h2 class="font-medium">{{ i18n.t('web.alerts.emailTitle') }}</h2>
      @if (prefs.hasValue()) {
        <form class="mt-3 flex flex-col gap-3" (ngSubmit)="savePrefs()">
          <mat-checkbox name="instantHigh" [ngModel]="instantHigh()" (ngModelChange)="instantHigh.set($event)">{{ i18n.t('web.alerts.instantHigh') }}</mat-checkbox>
          <mat-form-field>
            <mat-label>{{ i18n.t('web.alerts.digest') }}</mat-label>
            <mat-select name="digest" [ngModel]="digest()" (ngModelChange)="digest.set($event)">
              <mat-option value="daily">{{ i18n.t('web.alerts.digestDaily') }}</mat-option>
              <mat-option value="weekly">{{ i18n.t('web.alerts.digestWeekly') }}</mat-option>
              <mat-option value="off">{{ i18n.t('web.alerts.digestOff') }}</mat-option>
            </mat-select>
          </mat-form-field>
          @if (prefsForm.error(); as error) {
            <app-alert>{{ error }}</app-alert>
          } @else if (prefsSaved()) {
            <app-alert kind="success">{{ i18n.t('web.alerts.saved') }}</app-alert>
          }
          <button matButton="filled" type="submit" class="self-start" [disabled]="prefsForm.busy()">{{ i18n.t('web.alerts.save') }}</button>
        </form>
      } @else if (prefs.error(); as error) {
        <app-alert class="mt-3 block">{{ errorText(error) }}</app-alert>
      }
    </section>
  `,
})
export class AlertList {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  protected readonly alertCount = inject(AlertCount);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  readonly severity = input<string>();
  readonly unread = input<string>();
  readonly firm = input<string>();
  readonly origin = input<string>();
  readonly commodity = input<string>();
  readonly destination = input<string>();
  readonly hazard = input<string>();

  private readonly filters = computed(() => {
    const filters: Record<string, string> = {};
    for (const name of FILTERS) {
      const value = this[name]();
      if (value) filters[name] = value;
    }
    return filters;
  });
  private readonly filtersKey = computed(() => JSON.stringify(this.filters()));
  /** True when the list is narrowed to one watchlist item. */
  protected readonly scoped = computed(() => !!(this.firm() || this.origin()));
  protected readonly list = httpResource<AlertsResponse>(() => ({ url: apiUrl('/v1/alerts'), params: this.filters() }));

  /** The pages shown, as for notices; marking an alert read updates it here too. */
  private readonly pages = linkedSignal(() => (this.list.hasValue() ? [this.list.value()] : []));
  protected readonly items = computed(() => this.pages().flatMap((page) => page.items));
  protected readonly next = computed(() => this.pages()[this.pages().length - 1]?.next ?? null);
  protected readonly loadingMore = signal(false);
  protected readonly marking = signal(false);
  protected readonly actionError = linkedSignal<string, string | null>({ source: this.filtersKey, computation: () => null });

  protected readonly prefs = httpResource<NotificationPrefs>(() => apiUrl('/v1/me/notification-prefs'));
  protected readonly instantHigh = linkedSignal(() => (this.prefs.hasValue() ? this.prefs.value().instantHigh : true));
  protected readonly digest = linkedSignal<NotificationPrefs['digest']>(() => (this.prefs.hasValue() ? this.prefs.value().digest : 'daily'));
  protected readonly prefsForm = new FormState(this.i18n);
  protected readonly prefsSaved = signal(false);

  protected navigate(params: Record<string, string | null>): void {
    void this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge' });
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.next();
    if (!cursor || this.loadingMore()) return;
    const key = this.filtersKey();
    this.loadingMore.set(true);
    try {
      const page = await firstValueFrom(this.http.get<AlertsResponse>(apiUrl('/v1/alerts'), { params: { ...this.filters(), cursor } }));
      if (key === this.filtersKey()) this.pages.update((pages) => [...pages, page]);
    } catch (error) {
      if (key === this.filtersKey()) this.actionError.set(errorMessage(this.i18n, error));
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected markRead(alert: AlertItem): void {
    void this.mark({ ids: [alert.id] }, (a) => a.id === alert.id);
  }

  protected markAll(): void {
    void this.mark({ all: true }, () => true);
  }

  /** Marks alerts read on the API, then in the pages shown and in the top bar's count. */
  private async mark(body: { ids: string[] } | { all: true }, matches: (a: AlertItem) => boolean): Promise<void> {
    if (this.marking()) return;
    this.marking.set(true);
    this.actionError.set(null);
    try {
      const { updated } = await firstValueFrom(this.http.post<{ updated: number }>(apiUrl('/v1/alerts/read'), body));
      const readAt = new Date().toISOString();
      this.pages.update((pages) => pages.map((page) => ({ ...page, items: page.items.map((a) => (!a.readAt && matches(a) ? { ...a, readAt } : a)) })));
      this.alertCount.unread.update((count) => ('all' in body ? 0 : Math.max(0, (count ?? 0) - updated)));
    } catch (error) {
      this.actionError.set(errorMessage(this.i18n, error));
    } finally {
      this.marking.set(false);
    }
  }

  protected savePrefs(): void {
    this.prefsSaved.set(false);
    void this.prefsForm.run(async () => {
      await firstValueFrom(this.http.put(apiUrl('/v1/me/notification-prefs'), { instantHigh: this.instantHigh(), digest: this.digest() }));
      this.prefsSaved.set(true);
    });
  }
}
