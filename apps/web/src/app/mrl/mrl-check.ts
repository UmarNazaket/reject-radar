import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import type { MrlResponse, ResidueItem, ResidueSearchResponse } from '@rejectradar/contracts';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';

const LAB_VALUE = /^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,6})?$/;

/** The EU MRL checker: a commodity and a pesticide residue give the EU limits, optionally against a lab value. */
@Component({
  selector: 'app-mrl-check',
  imports: [FormsModule, MatAutocompleteModule, MatFormFieldModule, MatInputModule, MatSelectModule, Alert],
  template: `
    <h1 class="text-2xl font-semibold">{{ i18n.t('web.mrl.title') }}</h1>
    <p class="mt-1 text-slate-600">{{ i18n.t('web.mrl.intro') }}</p>

    <div class="mt-6 grid items-start gap-3 sm:grid-cols-3">
      <mat-form-field>
        <mat-label>{{ i18n.t('web.topics.commodity') }}</mat-label>
        <mat-select [value]="commodity() ?? null" (selectionChange)="navigate({ commodity: $event.value })">
          @for (c of taxonomy.commodityTree(); track c.id) {
            <mat-option [value]="c.id.toString()" [style.padding-inline-start.px]="16 + c.depth * 16">{{ c.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.mrl.residue') }}</mat-label>
        <input matInput dir="ltr" [ngModel]="residueText()" (ngModelChange)="residueText.set($event)" [matAutocomplete]="residues" />
        <mat-autocomplete #residues="matAutocomplete">
          @for (r of residueOptions(); track r.id) {
            <mat-option [value]="r.name" (onSelectionChange)="$event.isUserInput && pickResidue(r)">{{ r.name }}</mat-option>
          }
        </mat-autocomplete>
        <mat-hint>{{ i18n.t('web.mrl.residueHint') }}</mat-hint>
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.mrl.lab') }}</mat-label>
        <input matInput inputmode="decimal" dir="ltr" [ngModel]="labText()" (ngModelChange)="labText.set($event)" (change)="setLab()" />
        <span matTextSuffix>mg/kg</span>
        @if (labInvalid()) {
          <mat-hint class="text-red-700">{{ i18n.t('web.mrl.labInvalid') }}</mat-hint>
        } @else {
          <mat-hint>{{ i18n.t('web.mrl.labHint') }}</mat-hint>
        }
      </mat-form-field>
    </div>

    @if (!query()) {
      <p class="mt-4 rounded-lg border border-slate-200 bg-white p-6 text-slate-600">{{ i18n.t('web.mrl.empty') }}</p>
    } @else if (result.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (result.hasValue()) {
      @let r = result.value();
      <section class="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.mrl.limits', { residue: r.residue.name, commodity: taxonomy.label('commodity', r.commodityId) }) }}</h2>
        @if (r.limits.length === 0) {
          <p class="text-slate-600">{{ i18n.t(r.productCodes.length === 0 ? 'web.mrl.noProducts' : 'web.mrl.noLimits') }}</p>
        } @else {
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-slate-600">
                <tr class="border-b border-slate-200">
                  <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.mrl.product') }}</th>
                  <th scope="col" class="py-2 pe-4 text-end font-medium">{{ i18n.t('web.mrl.mrl') }}</th>
                  @if (lab()) {
                    <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.mrl.yourValue', { value: lab() ?? '' }) }}</th>
                  }
                  <th scope="col" class="py-2 pe-4 text-start font-medium">{{ i18n.t('web.mrl.from') }}</th>
                  <th scope="col" class="py-2 text-start font-medium">{{ i18n.t('web.mrl.legalRef') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (l of r.limits; track l.productCode) {
                  <tr class="border-b border-slate-100 align-top">
                    <td class="py-2 pe-4" dir="ltr">{{ l.productName }} <span class="text-slate-500">({{ l.productCode }})</span></td>
                    <td class="py-2 pe-4 text-end whitespace-nowrap" dir="ltr">
                      {{ l.mrlMgKg === null ? i18n.t('web.mrl.noLimitNeeded') : l.mrlMgKg + (l.isLod ? '*' : '') + ' mg/kg' }}
                    </td>
                    @if (lab()) {
                      <td class="py-2 pe-4">
                        @if (l.comparison === 'above') {
                          <span class="inline-block rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-800">{{ i18n.t('web.mrl.above') }}</span>
                        } @else if (l.comparison === 'at_or_below') {
                          <span class="inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">{{ i18n.t('web.mrl.atOrBelow') }}</span>
                        } @else {
                          —
                        }
                      </td>
                    }
                    <td class="py-2 pe-4 whitespace-nowrap">{{ l.applicableFrom ? i18n.date(l.applicableFrom) : '—' }}</td>
                    <td class="py-2" dir="ltr">{{ l.legalRef ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (hasLod(r)) {
            <p class="mt-2 text-sm text-slate-600">{{ i18n.t('web.mrl.lod') }}</p>
          }
        }
      </section>

      <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.mrl.notices') }}</h2>
        <ul class="divide-y divide-slate-100 text-sm">
          @for (n of r.notices; track n.reference) {
            <li class="flex flex-wrap gap-x-3 py-2">
              <span class="font-medium whitespace-nowrap">{{ i18n.date(n.notifiedOn) }}</span>
              <span class="flex-1" lang="en" dir="ltr">{{ n.subject }}</span>
              <span class="text-slate-600">{{ countries(n.originCountries) }}</span>
              @if (n.url) {
                <a [href]="n.url" target="_blank" rel="noopener" class="text-sky-700 underline">{{ n.reference }}</a>
              } @else {
                <span>{{ n.reference }}</span>
              }
            </li>
          } @empty {
            <li class="py-2 text-slate-600">{{ i18n.t('web.mrl.noNotices') }}</li>
          }
        </ul>
      </section>
      <p class="mt-6 text-sm text-slate-600">{{ i18n.t('web.mrl.disclaimer') }}</p>
    } @else {
      <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class MrlCheck {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  private readonly router = inject(Router);

  // The check lives in the URL (`?commodity=201&residue=<id>&lab=0.05`), so it can be shared.
  readonly commodity = input<string>();
  readonly residue = input<string>();
  readonly lab = input<string>();

  private readonly query = computed(() => {
    const commodity = this.commodity();
    const residue = this.residue();
    if (!commodity || !residue) return null;
    const lab = this.lab();
    return { commodity, residue, ...(lab ? { lab } : {}) };
  });
  protected readonly result = httpResource<MrlResponse>(() => {
    const query = this.query();
    return query ? { url: apiUrl('/v1/mrl'), params: query } : undefined;
  });

  /** The residue box: what the user types, or the chosen residue's name once the check has loaded. */
  protected readonly residueText = linkedSignal<string | undefined, string>({
    source: () => (this.result.hasValue() ? this.result.value().residue.name : undefined),
    // While a new check loads, the box keeps what it shows.
    computation: (name, previous) => name ?? previous?.value ?? '',
  });
  private readonly residueSearch = httpResource<ResidueSearchResponse>(() => {
    const q = this.residueText().trim();
    return q.length >= 2 ? { url: apiUrl('/v1/mrl/residues'), params: { q } } : undefined;
  });
  protected readonly residueOptions = computed(() => (this.residueSearch.hasValue() ? this.residueSearch.value().residues : []));

  protected readonly labText = linkedSignal(() => this.lab() ?? '');
  protected readonly labInvalid = computed(() => this.labText().trim() !== '' && !LAB_VALUE.test(this.labText().trim()));

  protected navigate(params: Record<string, string | null>): void {
    void this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge' });
  }

  protected pickResidue(residue: ResidueItem): void {
    this.navigate({ residue: residue.id });
  }

  protected setLab(): void {
    const value = this.labText().trim();
    if (!this.labInvalid()) this.navigate({ lab: value || null });
  }

  protected hasLod(r: MrlResponse): boolean {
    return r.limits.some((l) => l.isLod);
  }

  protected countries(codes: string[]): string {
    return codes.map((code) => this.taxonomy.label('country', code)).join(', ');
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }
}
