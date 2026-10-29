import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import type { FirmSearchResponse } from '@rejectradar/contracts';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';

const LABEL_STYLES: Record<string, string> = {
  strong: 'bg-emerald-50 text-emerald-800',
  possible: 'bg-amber-50 text-amber-900',
  other: 'bg-slate-100 text-slate-700',
};

/** Firm search by name (with country and city) or by FDA establishment number; searching uses no lookup. */
@Component({
  selector: 'app-firm-search',
  imports: [FormsModule, RouterLink, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, Alert],
  template: `
    <h1 class="text-2xl font-semibold">{{ i18n.t('web.firms.title') }}</h1>
    <p class="mt-1 text-slate-600">{{ i18n.t('web.firms.intro') }}</p>

    <form #f="ngForm" class="mt-6 grid gap-x-3 sm:grid-cols-2 lg:grid-cols-4" (ngSubmit)="f.valid && submit()">
      <mat-form-field>
        <mat-label>{{ i18n.t('web.firms.name') }}</mat-label>
        <input matInput name="name" minlength="2" maxlength="200" [required]="!form().fei" [(ngModel)]="form().name" />
        <mat-error>{{ i18n.t('web.firms.nameOrFei') }}</mat-error>
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.topics.origin') }}</mat-label>
        <mat-select name="country" [(ngModel)]="form().country">
          <mat-option [value]="''">{{ i18n.t('web.notices.any') }}</mat-option>
          @for (c of taxonomy.countries(); track c.code) {
            <mat-option [value]="c.code">{{ c.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.firms.city') }}</mat-label>
        <input matInput name="city" maxlength="100" [(ngModel)]="form().city" />
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.firms.fei') }}</mat-label>
        <input matInput name="fei" inputmode="numeric" pattern="[0-9]{1,15}" [(ngModel)]="form().fei" />
        <mat-error>{{ i18n.t('web.firms.feiDigits') }}</mat-error>
      </mat-form-field>
      <div>
        <button matButton="filled" type="submit">{{ i18n.t('web.notices.search') }}</button>
      </div>
    </form>

    @if (query()) {
      @if (results.error(); as error) {
        <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
      } @else if (results.hasValue()) {
        @if (results.value().results.length === 0) {
          <p class="mt-4 rounded-lg border border-slate-200 bg-white p-6 text-slate-600">{{ i18n.t('web.firms.none') }}</p>
        } @else {
          <ul class="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            @for (r of results.value().results; track r.id) {
              <li class="flex flex-wrap items-center gap-x-4 gap-y-1 p-4">
                <a [routerLink]="['/firms', r.id]" [queryParams]="{ q: query()?.['name'] ?? null }" class="font-medium text-sky-700 underline">{{ r.displayName }}</a>
                <span class="inline-block rounded px-1.5 py-0.5 text-xs" [class]="labelStyles[r.label]">{{ i18n.t('web.firms.label.' + r.label) }}</span>
                <span class="text-sm text-slate-600">{{ place(r.city, r.region, r.countryCode) }}</span>
                @if (r.lastNoticeOn) {
                  <span class="ms-auto text-sm text-slate-600">{{ i18n.t('web.firms.lastNotice', { date: i18n.date(r.lastNoticeOn) }) }}</span>
                }
              </li>
            }
          </ul>
          <p class="mt-3 text-sm text-slate-600">{{ i18n.t('web.firms.lookupNote') }}</p>
        }
      } @else {
        <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
      }
    }
  `,
})
export class FirmSearch {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  private readonly router = inject(Router);
  protected readonly labelStyles = LABEL_STYLES;

  // The search lives in the URL (`?name=&country=&city=&fei=`), so the back button returns to the results.
  readonly name = input<string>();
  readonly country = input<string>();
  readonly city = input<string>();
  readonly fei = input<string>();

  /** The form's fields, reset to the URL's whenever that changes. */
  protected readonly form = linkedSignal(() => ({ name: this.name() ?? '', country: this.country() ?? '', city: this.city() ?? '', fei: this.fei() ?? '' }));
  protected readonly query = computed(() => {
    const query: Record<string, string> = {};
    for (const [key, value] of [['name', this.name()], ['country', this.country()], ['city', this.city()], ['fei', this.fei()]] as const) {
      if (value) query[key] = value;
    }
    return query['name'] || query['fei'] ? query : null;
  });
  protected readonly results = httpResource<FirmSearchResponse>(() => {
    const query = this.query();
    return query ? { url: apiUrl('/v1/firms/search'), params: query } : undefined;
  });

  protected submit(): void {
    const { name, country, city, fei } = this.form();
    const params = { name: name.trim() || null, country: country || null, city: city.trim() || null, fei: fei.trim() || null };
    void this.router.navigate([], { queryParams: params });
  }

  protected place(city: string | null, region: string | null, country: string | null): string {
    return [city, region, country ? this.taxonomy.label('country', country) : null].filter(Boolean).join(', ');
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }
}
