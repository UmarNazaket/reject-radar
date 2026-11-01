import { HttpClient, HttpParams, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import type { CreateWatchlistItemRequest, DashboardResponse, Destination, TopicEstimateResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { downloadFile } from '../core/download';
import { errorMessage, needsUpgrade } from '../core/errors';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';
import { TopicDashboard } from './topic-dashboard';

/** The home screen: pick an origin, and optionally a commodity and destinations, to see that topic's border rejections. */
@Component({
  selector: 'app-topic-check',
  imports: [MatFormFieldModule, MatSelectModule, MatButtonModule, Alert, TopicDashboard],
  template: `
    <h1 class="text-2xl font-semibold">{{ i18n.t('web.topics.title') }}</h1>
    <p class="mt-1 text-slate-600">{{ i18n.t('web.topics.intro') }}</p>

    @if (taxonomy.data.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    }
    <div class="mt-6 grid items-start gap-3 sm:grid-cols-3">
      <mat-form-field>
        <mat-label>{{ i18n.t('web.topics.origin') }}</mat-label>
        <mat-select [value]="origin()" (selectionChange)="navigate({ origin: $event.value })">
          @for (c of taxonomy.countries(); track c.code) {
            <mat-option [value]="c.code">{{ c.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.topics.commodity') }}</mat-label>
        <mat-select [value]="commodity() ?? null" (selectionChange)="navigate({ commodity: $event.value })">
          <mat-option [value]="null">{{ i18n.t('web.topics.anyCommodity') }}</mat-option>
          @for (c of taxonomy.commodityTree(); track c.id) {
            <mat-option [value]="c.id.toString()" [style.padding-inline-start.px]="16 + c.depth * 16">{{ c.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field floatLabel="always">
        <mat-label>{{ i18n.t('web.topics.destinations') }}</mat-label>
        <mat-select multiple [value]="chosenDestinations()" [placeholder]="i18n.t('web.topics.allDestinations')" (selectionChange)="navigate({ destination: $event.value.join(',') || null })">
          @for (d of taxonomy.destinations(); track d.id) {
            <mat-option [value]="d.id">{{ d.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    </div>

    @if (!origin()) {
      <p class="rounded-lg border border-slate-200 bg-white p-6 text-slate-600">{{ i18n.t('web.topics.empty') }}</p>
    } @else {
      <div class="mt-4 mb-4 flex flex-wrap items-center gap-3">
        <button matButton="filled" type="button" [disabled]="busy() || chosenDestinations().length > 1" (click)="watch()">{{ i18n.t('web.topics.watch') }}</button>
        <button matButton="outlined" type="button" [disabled]="busy()" (click)="downloadPdf()">{{ i18n.t('web.topics.pdf') }}</button>
        @if (chosenDestinations().length > 1) {
          <span class="text-sm text-slate-600">{{ i18n.t('web.topics.watchOneDestination') }}</span>
        } @else if (estimate.hasValue()) {
          <span class="text-sm text-slate-600">{{ i18n.t('web.topics.estimate', { perMonth: estimate.value().perMonth }) }}</span>
        }
      </div>
      @if (result(); as r) {
        @if (r.key === topicKey()) {
          <app-alert class="mb-4 block" [kind]="r.kind" [upgrade]="!!r.upgrade">{{ r.text }}</app-alert>
        }
      }
      @if (dashboard.error(); as error) {
        <app-alert>{{ errorText(error) }}</app-alert>
      } @else if (dashboard.hasValue()) {
        <app-topic-dashboard [dashboard]="dashboard.value()" [destinations]="shownDestinations()" />
      } @else {
        <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
      }
    }
  `,
})
export class TopicCheck {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  // The topic lives in the URL (`?origin=IN&commodity=201&destination=US,EU`), so it can be shared and bookmarked.
  readonly origin = input<string>();
  readonly commodity = input<string>();
  readonly destination = input<string>();

  protected readonly chosenDestinations = computed(() => (this.destination() ?? '').split(',').filter((d) => d !== '') as Destination[]);
  protected readonly shownDestinations = computed(() =>
    this.chosenDestinations().length > 0 ? this.chosenDestinations() : this.taxonomy.destinations().map((d) => d.id),
  );
  private readonly query = computed(() => {
    const origin = this.origin();
    if (!origin) return null;
    const query: Record<string, string> = { origin };
    if (this.commodity()) query['commodity'] = this.commodity() as string;
    if (this.destination()) query['destination'] = this.destination() as string;
    return query;
  });
  protected readonly topicKey = computed(() => JSON.stringify(this.query()));
  protected readonly dashboard = httpResource<DashboardResponse>(() => {
    const query = this.query();
    return query ? { url: apiUrl('/v1/dashboards/topic'), params: query } : undefined;
  });

  /** How many notices a month the topic would have alerted on, shown next to "Watch this topic". */
  protected readonly estimate = httpResource<TopicEstimateResponse>(() => {
    const origin = this.origin();
    if (!origin || this.chosenDestinations().length > 1) return undefined;
    const params: Record<string, string> = { originCountry: origin };
    if (this.commodity()) params['commodityId'] = this.commodity() as string;
    if (this.chosenDestinations()[0]) params['destination'] = this.chosenDestinations()[0];
    return { url: apiUrl('/v1/watchlist/topic-estimate'), params };
  });

  protected readonly busy = signal(false);
  /** The outcome of the last action, kept with the topic it was for, so it is not shown once the topic changes. */
  protected readonly result = signal<{ key: string; kind: 'success' | 'error'; text: string; upgrade?: boolean } | null>(null);

  protected navigate(params: Record<string, string | null>): void {
    void this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge' });
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected watch(): void {
    const body: CreateWatchlistItemRequest = {
      kind: 'topic',
      originCountry: this.origin() as string,
      commodityId: this.commodity() ? Number(this.commodity()) : undefined,
      destination: this.chosenDestinations()[0],
    };
    void this.act(async () => {
      await firstValueFrom(this.http.post(apiUrl('/v1/watchlist'), body));
      return this.i18n.t('web.topics.watched');
    });
  }

  protected downloadPdf(): void {
    const query = this.query() as Record<string, string>;
    const fileName = `rejectradar-topic-${query['origin']}-${query['commodity'] ?? 'all'}-${this.chosenDestinations().join('+') || 'all'}.pdf`;
    void this.act(async () => {
      await downloadFile(this.http, apiUrl('/v1/dashboards/topic/report.pdf'), new HttpParams({ fromObject: query }), fileName.toLowerCase());
      return null;
    });
  }

  /** Runs one action at a time; its message, if any, is kept with the topic it was for. */
  private async act(action: () => Promise<string | null>): Promise<void> {
    if (this.busy()) return;
    const key = this.topicKey();
    this.busy.set(true);
    this.result.set(null);
    try {
      const text = await action();
      if (text) this.result.set({ key, kind: 'success', text });
    } catch (error) {
      this.result.set({ key, kind: 'error', text: errorMessage(this.i18n, error), upgrade: needsUpgrade(error) });
    } finally {
      this.busy.set(false);
    }
  }
}
