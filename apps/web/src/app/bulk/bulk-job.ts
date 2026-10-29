import { HttpClient, HttpParams, httpResource } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, input, linkedSignal, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import type { BulkJobResponse, BulkRowResponse, BulkRowsResponse, WatchConfirmedResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { downloadFile } from '../core/download';
import { errorMessage } from '../core/errors';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';

const STATUS_FILTERS = ['review', 'matched', 'confirmed', 'no_record', 'rejected'];
const POLL_MS = 3000;

/** One bulk job: its progress while it runs, then the rows to review, "Watch confirmed" and the export. */
@Component({
  selector: 'app-bulk-job',
  imports: [RouterLink, MatButtonModule, Alert],
  template: `
    <a routerLink="/bulk" class="text-sm text-sky-700 underline">{{ i18n.t('web.bulk.title') }}</a>
    @if (job.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (job.hasValue()) {
      @let j = job.value();
      <h1 class="mt-3 text-2xl font-semibold" dir="ltr">{{ j.fileName }}</h1>
      <p class="mt-1 text-sm text-slate-600">{{ i18n.t('web.bulk.status.' + j.status) }} · {{ i18n.t('web.bulk.progress', { processed: j.processed, total: j.total }) }}</p>
      @if (j.status !== 'finished') {
        <div class="mt-3 h-2 max-w-xl rounded bg-slate-100" role="progressbar" [attr.aria-valuenow]="j.processed" aria-valuemin="0" [attr.aria-valuemax]="j.total">
          <div class="h-2 rounded bg-[#2a78d6]" [style.width.%]="j.total ? (j.processed / j.total) * 100 : 0"></div>
        </div>
      } @else {
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <button matButton="filled" type="button" [disabled]="action.busy()" (click)="watchConfirmed()">{{ i18n.t('web.bulk.watchConfirmed') }}</button>
          <button matButton="outlined" type="button" [disabled]="action.busy()" (click)="exportCsv(j)">{{ i18n.t('web.bulk.export') }}</button>
        </div>
        @if (action.error(); as error) {
          <app-alert class="mt-4 block">{{ error }}</app-alert>
        } @else if (watched(); as w) {
          <app-alert kind="success" class="mt-4 block">{{ i18n.t('web.bulk.watched', { added: w.added, already: w.alreadyWatched, over: w.overLimit }) }}</app-alert>
        }

        <nav class="mt-6 flex flex-wrap gap-1 text-sm" [attr.aria-label]="i18n.t('web.bulk.filter')">
          <a routerLink="." [queryParams]="{ status: null }" class="rounded-md px-3 py-1.5" [class.bg-slate-200]="!status()">{{ i18n.t('web.bulk.all') }}</a>
          @for (s of statusFilters; track s) {
            <a routerLink="." [queryParams]="{ status: s }" class="rounded-md px-3 py-1.5" [class.bg-slate-200]="status() === s">{{ i18n.t('web.bulk.rowStatus.' + s) }}</a>
          }
        </nav>

        @if (rows.error(); as error) {
          <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
        } @else if (rows.hasValue()) {
          @if (rowError(); as error) {
            <app-alert class="mt-4 block">{{ error }}</app-alert>
          }
          <ul class="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            @for (r of items(); track r.id) {
              <li class="p-4 text-sm">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span class="text-slate-500">#{{ r.rowNr }}</span>
                  <span class="font-medium" dir="ltr">{{ r.input.name }}</span>
                  <span class="text-slate-600">{{ inputPlace(r) }}</span>
                  <span class="ms-auto rounded bg-slate-100 px-1.5 py-0.5 text-xs">{{ r.failed ? i18n.t('web.bulk.searchFailed') : i18n.t('web.bulk.rowStatus.' + r.status) }}</span>
                </div>
                @if (r.firm; as firm) {
                  <p class="mt-1">
                    <a [routerLink]="['/firms', firm.id]" class="text-sky-700 underline">{{ firm.displayName }}</a>
                    @if (r.facts; as f) {
                      ·
                      @if (f.importAlertRed) {
                        <span class="text-red-800">{{ i18n.t('web.bulk.redList') }}</span> ·
                      }
                      {{ i18n.t('web.bulk.facts', { refusals: f.fdaRefusals3y, au: f.auFailed3y }) }}
                    }
                  </p>
                }
                @if (r.status === 'review') {
                  <div class="mt-2 flex flex-col gap-1">
                    @for (c of r.candidates; track c.firmId) {
                      <div class="flex flex-wrap items-center gap-x-3">
                        <span>{{ c.displayName }}</span>
                        <span class="text-slate-600">{{ candidatePlace(c.city, c.countryCode) }} · {{ i18n.t('web.firms.label.' + c.label) }}</span>
                        <button matButton type="button" [disabled]="reviewing()" (click)="review(r, { action: 'confirm', firmId: c.firmId })">{{ i18n.t('web.bulk.confirm') }}</button>
                      </div>
                    }
                    <button matButton type="button" class="self-start" [disabled]="reviewing()" (click)="review(r, { action: 'reject' })">{{ i18n.t('web.bulk.reject') }}</button>
                  </div>
                }
              </li>
            } @empty {
              <li class="p-6 text-slate-600">{{ i18n.t('web.bulk.noRows') }}</li>
            }
          </ul>
          @if (next()) {
            <button matButton="outlined" type="button" class="mt-4" [disabled]="loadingMore()" (click)="loadMore()">{{ i18n.t('web.notices.more') }}</button>
          }
        } @else {
          <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
        }
      }
    } @else {
      <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class BulkJob {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  private readonly http = inject(HttpClient);
  protected readonly statusFilters = STATUS_FILTERS;

  readonly id = input.required<string>();
  /** `?status=`: one row status, or every row. */
  readonly status = input<string>();

  protected readonly job = httpResource<BulkJobResponse>(() => apiUrl(`/v1/bulk-jobs/${encodeURIComponent(this.id())}`));
  private readonly rowParams = computed((): Record<string, string> => {
    const status = this.status();
    return status ? { status } : {};
  });
  private readonly finished = computed(() => this.job.hasValue() && this.job.value().status === 'finished');
  protected readonly rows = httpResource<BulkRowsResponse>(() =>
    this.finished() ? { url: apiUrl(`/v1/bulk-jobs/${encodeURIComponent(this.id())}/rows`), params: this.rowParams() } : undefined,
  );
  private readonly rowsKey = computed(() => `${this.id()}|${this.status() ?? ''}`);

  /** The pages shown; a reviewed row is replaced by the API's answer. */
  private readonly pages = linkedSignal(() => (this.rows.hasValue() ? [this.rows.value()] : []));
  protected readonly items = computed(() => this.pages().flatMap((page) => page.rows));
  protected readonly next = computed(() => this.pages()[this.pages().length - 1]?.nextCursor ?? null);
  protected readonly loadingMore = signal(false);
  protected readonly reviewing = signal(false);
  protected readonly rowError = linkedSignal<string, string | null>({ source: this.rowsKey, computation: () => null });

  protected readonly action = new FormState(this.i18n);
  protected readonly watched = signal<WatchConfirmedResponse | null>(null);

  constructor() {
    // A running job is asked for again every few seconds until it finishes.
    const timer = setInterval(() => {
      if (this.job.hasValue() && !this.finished() && !this.job.isLoading()) this.job.reload();
    }, POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected inputPlace(r: BulkRowResponse): string {
    const { city, country, fei } = r.input;
    return [city, country ? this.taxonomy.label('country', country) : null, fei ? `FEI ${fei}` : null].filter(Boolean).join(', ');
  }

  protected candidatePlace(city: string | null, country: string | null): string {
    return [city, country ? this.taxonomy.label('country', country) : null].filter(Boolean).join(', ');
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.next();
    if (!cursor || this.loadingMore()) return;
    const key = this.rowsKey();
    this.loadingMore.set(true);
    try {
      const page = await firstValueFrom(
        this.http.get<BulkRowsResponse>(apiUrl(`/v1/bulk-jobs/${encodeURIComponent(this.id())}/rows`), { params: { ...this.rowParams(), cursor } }),
      );
      if (key === this.rowsKey()) this.pages.update((pages) => [...pages, page]);
    } catch (error) {
      if (key === this.rowsKey()) this.rowError.set(errorMessage(this.i18n, error));
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected async review(row: BulkRowResponse, body: { action: 'confirm'; firmId: number } | { action: 'reject' }): Promise<void> {
    if (this.reviewing()) return;
    this.reviewing.set(true);
    this.rowError.set(null);
    try {
      const updated = await firstValueFrom(this.http.patch<BulkRowResponse>(apiUrl(`/v1/bulk-jobs/${encodeURIComponent(this.id())}/rows/${row.id}`), body));
      this.pages.update((pages) => pages.map((page) => ({ ...page, rows: page.rows.map((r) => (r.id === updated.id ? updated : r)) })));
    } catch (error) {
      this.rowError.set(errorMessage(this.i18n, error));
    } finally {
      this.reviewing.set(false);
    }
  }

  protected watchConfirmed(): void {
    this.watched.set(null);
    void this.action.run(async () => {
      this.watched.set(await firstValueFrom(this.http.post<WatchConfirmedResponse>(apiUrl(`/v1/bulk-jobs/${encodeURIComponent(this.id())}/watch-confirmed`), {})));
    });
  }

  protected exportCsv(j: BulkJobResponse): void {
    void this.action.run(() => downloadFile(this.http, apiUrl(`/v1/bulk-jobs/${encodeURIComponent(j.id)}/export.csv`), new HttpParams(), `bulk-${j.id}.csv`));
  }
}
