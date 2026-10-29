import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import type { NoticeSearchResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';
import { NoticeTable } from './notice-table';

const NOTICE_SOURCES = ['fda_refusal', 'import_alert', 'rasff', 'uk_bn', 'au_ifis'];
const FILTERS = ['q', 'origin', 'commodity', 'hazardCategory', 'destination', 'source', 'from', 'to'] as const;

/** Notice search: every filter lives in the URL, so a search can be shared; "Show more" follows the API's cursor. */
@Component({
  selector: 'app-notice-search',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, Alert, NoticeTable],
  template: `
    <h1 class="text-2xl font-semibold">{{ i18n.t('web.notices.title') }}</h1>

    <form #f="ngForm" class="mt-6 flex flex-wrap items-start gap-3" (ngSubmit)="f.valid && navigate({ q: text().trim() || null })">
      <mat-form-field class="min-w-64 flex-1">
        <mat-label>{{ i18n.t('web.notices.q') }}</mat-label>
        <input matInput name="q" minlength="3" maxlength="100" [ngModel]="text()" (ngModelChange)="text.set($event)" />
        <mat-error>{{ i18n.t('web.notices.qTooShort') }}</mat-error>
      </mat-form-field>
      <button matButton="filled" type="submit" class="mt-2">{{ i18n.t('web.notices.search') }}</button>
    </form>
    <div class="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-4">
      <mat-form-field>
        <mat-label>{{ i18n.t('web.topics.origin') }}</mat-label>
        <mat-select [value]="origin() ?? null" (selectionChange)="navigate({ origin: $event.value })">
          <mat-option [value]="null">{{ i18n.t('web.notices.any') }}</mat-option>
          @for (c of taxonomy.countries(); track c.code) {
            <mat-option [value]="c.code">{{ c.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.topics.commodity') }}</mat-label>
        <mat-select [value]="commodity() ?? null" (selectionChange)="navigate({ commodity: $event.value })">
          <mat-option [value]="null">{{ i18n.t('web.notices.any') }}</mat-option>
          @for (c of taxonomy.commodityTree(); track c.id) {
            <mat-option [value]="c.id.toString()" [style.padding-inline-start.px]="16 + c.depth * 16">{{ c.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.notices.hazardCategory') }}</mat-label>
        <mat-select [value]="hazardCategory() ?? null" (selectionChange)="navigate({ hazardCategory: $event.value })">
          <mat-option [value]="null">{{ i18n.t('web.notices.any') }}</mat-option>
          @for (c of taxonomy.hazardCategories(); track c.id) {
            <mat-option [value]="c.id">{{ c.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field floatLabel="always">
        <mat-label>{{ i18n.t('web.topics.destinations') }}</mat-label>
        <mat-select multiple [value]="list(destination())" [placeholder]="i18n.t('web.topics.allDestinations')" (selectionChange)="navigate({ destination: $event.value.join(',') || null })">
          @for (d of taxonomy.destinations(); track d.id) {
            <mat-option [value]="d.id">{{ d.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field floatLabel="always">
        <mat-label>{{ i18n.t('web.notices.sources') }}</mat-label>
        <mat-select multiple [value]="list(source())" [placeholder]="i18n.t('web.notices.allSources')" (selectionChange)="navigate({ source: $event.value.join(',') || null })">
          @for (s of sources; track s) {
            <mat-option [value]="s">{{ i18n.t('web.noticeSource.' + s) }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field floatLabel="always">
        <mat-label>{{ i18n.t('web.notices.from') }}</mat-label>
        <input matInput type="date" [value]="from() ?? ''" (change)="navigate({ from: dateValue($event) })" />
      </mat-form-field>
      <mat-form-field floatLabel="always">
        <mat-label>{{ i18n.t('web.notices.to') }}</mat-label>
        <input matInput type="date" [value]="to() ?? ''" (change)="navigate({ to: dateValue($event) })" />
      </mat-form-field>
      @if (hasFilters()) {
        <button matButton type="button" class="mt-2 justify-self-start" (click)="clear()">{{ i18n.t('web.notices.clear') }}</button>
      }
    </div>

    @if (search.error(); as error) {
      <app-alert>{{ errorText(error) }}</app-alert>
    } @else if (search.hasValue()) {
      @if (search.value().historyFrom; as historyFrom) {
        <p class="mb-3 text-sm text-slate-600">{{ i18n.t('web.topics.historyFrom', { date: i18n.date(historyFrom) }) }}</p>
      }
      @if (items().length === 0) {
        <p class="rounded-lg border border-slate-200 bg-white p-6 text-slate-600">{{ i18n.t('web.notices.none') }}</p>
      } @else {
        <section class="rounded-lg border border-slate-200 bg-white p-4">
          <app-notice-table [notices]="items()" />
        </section>
      }
      @if (moreError(); as error) {
        <app-alert class="mt-4 block">{{ error }}</app-alert>
      }
      @if (next()) {
        <button matButton="outlined" type="button" class="mt-4" [disabled]="loadingMore()" (click)="loadMore()">{{ i18n.t('web.notices.more') }}</button>
      }
    } @else {
      <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class NoticeSearch {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly sources = NOTICE_SOURCES;

  readonly q = input<string>();
  readonly origin = input<string>();
  readonly commodity = input<string>();
  readonly hazardCategory = input<string>();
  readonly destination = input<string>();
  readonly source = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();

  /** The search box, reset to the URL's `q` whenever that changes (back button, a cleared search). */
  protected readonly text = linkedSignal(() => this.q() ?? '');

  private readonly filters = computed(() => {
    const filters: Record<string, string> = {};
    for (const name of FILTERS) {
      const value = this[name]();
      if (value) filters[name] = value;
    }
    return filters;
  });
  private readonly filtersKey = computed(() => JSON.stringify(this.filters()));
  protected readonly hasFilters = computed(() => Object.keys(this.filters()).length > 0);
  protected readonly search = httpResource<NoticeSearchResponse>(() => ({ url: apiUrl('/v1/notices'), params: this.filters() }));

  /** The pages shown: the first from the search, then each "Show more"; a new search starts over. */
  private readonly pages = linkedSignal(() => (this.search.hasValue() ? [this.search.value()] : []));
  protected readonly items = computed(() => this.pages().flatMap((page) => page.items));
  protected readonly next = computed(() => this.pages()[this.pages().length - 1]?.next ?? null);
  protected readonly loadingMore = signal(false);
  /** A failed "Show more", cleared when the search changes. */
  protected readonly moreError = linkedSignal<string, string | null>({ source: this.filtersKey, computation: () => null });

  protected list(value: string | undefined): string[] {
    return (value ?? '').split(',').filter((part) => part !== '');
  }

  protected dateValue(event: Event): string | null {
    return (event.target as HTMLInputElement).value || null;
  }

  protected navigate(params: Record<string, string | null>): void {
    void this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge' });
  }

  protected clear(): void {
    void this.router.navigate([]);
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.next();
    if (!cursor || this.loadingMore()) return;
    const key = this.filtersKey();
    this.loadingMore.set(true);
    this.moreError.set(null);
    try {
      const page = await firstValueFrom(this.http.get<NoticeSearchResponse>(apiUrl('/v1/notices'), { params: { ...this.filters(), cursor } }));
      // A page for a search that has since changed is dropped.
      if (key === this.filtersKey()) this.pages.update((pages) => [...pages, page]);
    } catch (error) {
      if (key === this.filtersKey()) this.moreError.set(errorMessage(this.i18n, error));
    } finally {
      this.loadingMore.set(false);
    }
  }
}
