import { NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpParams, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import type { CreateDisputeRequest, CreateWatchlistItemRequest, FirmProfileResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { downloadFile } from '../core/download';
import { errorMessage } from '../core/errors';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';
import { DataDates } from '../layout/data-dates';

const DISPUTE_KINDS = ['wrong_firm', 'mixed_firms', 'wrong_details', 'other'];
/** Firms opened in this tab: opening one again this month uses no lookup, so it is not asked about again. */
const opened = new Set<string>();

interface RecordRow {
  key: string;
  date: string | null;
  label: string;
  /** In English, as the agency published them. */
  details: string[];
  url: string | null;
  alert?: string;
  removedOn?: string | null;
}

/** Records newer than this are shown first; older ones sit under "History" (spec §9.4). */
function threeYearsAgo(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 3);
  return date.toISOString().slice(0, 10);
}

/** A firm's profile: its facts, its FDA refusals, Import Alert listings and Australian failed tests, newest first. */
@Component({
  selector: 'app-firm-profile',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, Alert, DataDates],
  template: `
    <a routerLink="/firms" class="text-sm text-sky-700 underline">{{ i18n.t('web.firms.back') }}</a>
    @if (!confirmed()) {
      <section class="mt-4 max-w-xl rounded-lg border border-slate-200 bg-white p-6">
        <h1 class="text-xl font-semibold">{{ i18n.t('web.firms.confirmTitle') }}</h1>
        <p class="mt-2 text-slate-600">{{ i18n.t('web.firms.confirmBody') }}</p>
        <button matButton="filled" type="button" class="mt-4" (click)="open()">{{ i18n.t('web.firms.confirm') }}</button>
      </section>
    } @else if (profile.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (profile.hasValue()) {
      @let p = profile.value();
      <h1 class="mt-3 text-2xl font-semibold">{{ p.displayName }}</h1>
      @if (p.altNames.length > 0) {
        <p class="mt-1 text-sm text-slate-600">{{ i18n.t('web.firms.altNames', { names: p.altNames.join('; ') }) }}</p>
      }
      <p class="mt-1 text-sm text-slate-600">{{ place(p) }}</p>
      <p class="mt-1 text-sm text-slate-600">
        @if (p.feis.length > 0) {
          {{ i18n.t('web.firms.feis', { feis: p.feis.join(', ') }) }} ·
        }
        {{ i18n.t('web.firms.lookups', { used: p.lookup.used, limit: p.lookup.limit }) }}
        @if (!p.lookup.charged) {
          · {{ i18n.t('web.firms.notCharged') }}
        }
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button matButton="filled" type="button" [disabled]="busy()" (click)="watch(p)">{{ i18n.t('web.firms.watch') }}</button>
        <button matButton="outlined" type="button" [disabled]="busy()" (click)="downloadPdf(p)">{{ i18n.t('web.topics.pdf') }}</button>
        <button matButton type="button" (click)="disputeOpen.set(!disputeOpen())">{{ i18n.t('web.firms.dispute') }}</button>
      </div>
      @if (result(); as r) {
        @if (r.id === id()) {
          <app-alert class="mt-4 block" [kind]="r.kind">{{ r.text }}</app-alert>
        }
      }
      @if (disputeOpen()) {
        <form #d="ngForm" class="mt-4 max-w-xl rounded-lg border border-slate-200 bg-white p-4" (ngSubmit)="d.valid && sendDispute(p)">
          <h2 class="mb-3 font-medium">{{ i18n.t('web.firms.dispute') }}</h2>
          <mat-form-field class="w-full">
            <mat-label>{{ i18n.t('web.firms.disputeKind') }}</mat-label>
            <mat-select name="kind" [(ngModel)]="disputeKind">
              @for (k of disputeKinds; track k) {
                <mat-option [value]="k">{{ i18n.t('web.firms.disputeKinds.' + k) }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field class="w-full">
            <mat-label>{{ i18n.t('web.firms.disputeMessage') }}</mat-label>
            <textarea matInput name="message" rows="4" required minlength="10" maxlength="2000" [(ngModel)]="disputeMessage"></textarea>
            <mat-error>{{ i18n.t('web.firms.disputeTooShort') }}</mat-error>
          </mat-form-field>
          <button matButton="filled" type="submit" [disabled]="busy()">{{ i18n.t('web.firms.disputeSend') }}</button>
        </form>
      }

      <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.firms.facts') }}</h2>
        <ul class="flex flex-col gap-2 text-sm">
          @for (l of p.facts.import_alert_red; track l.alert) {
            <li class="text-red-800">
              {{ i18n.t('web.firms.redList', { alert: l.alert }) }}
              @if (l.listed_on) {
                ({{ i18n.t('web.firms.since', { date: i18n.date(l.listed_on) }) }})
              }
              · <a [routerLink]="['/import-alerts', l.alert]" class="text-sky-700 underline">{{ i18n.t('web.firms.openAlert') }}</a>
            </li>
          } @empty {
            <li>{{ i18n.t('web.firms.noRedList') }}</li>
          }
          @for (l of p.facts.import_alert_green; track l.alert) {
            <li>{{ i18n.t('web.firms.greenList', { alert: l.alert }) }} · <a [routerLink]="['/import-alerts', l.alert]" class="text-sky-700 underline">{{ i18n.t('web.firms.openAlert') }}</a></li>
          }
          <li>{{ i18n.t('web.firms.refusals', { recent: p.facts.fda_refusals_12m, history: p.facts.fda_refusals_3y }) }}</li>
          <li>{{ i18n.t('web.firms.auFailed', { count: p.facts.au_failed_3y }) }}</li>
          @if (p.facts.au_holding_order) {
            <li>{{ i18n.t('web.firms.holdingOrder') }}</li>
          }
          @if (p.facts.top_hazards_3y.length > 0) {
            <li>{{ i18n.t('web.firms.topHazards', { hazards: hazardGroups(p.facts.top_hazards_3y) }) }}</li>
          }
        </ul>
      </section>

      <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.firms.records') }}</h2>
        <ng-template #recordList let-rows>
          <ul class="divide-y divide-slate-100 text-sm">
            @for (r of rows; track r.key) {
              <li class="py-2">
                <div class="flex flex-wrap gap-x-3">
                  <span class="font-medium">{{ r.date ? i18n.date(r.date) : '—' }}</span>
                  <span>{{ r.label }}</span>
                  @if (r.removedOn) {
                    <span class="text-slate-600">{{ i18n.t('web.firms.removedOn', { date: i18n.date(r.removedOn) }) }}</span>
                  }
                  @if (r.alert) {
                    <a [routerLink]="['/import-alerts', r.alert]" class="text-sky-700 underline">{{ i18n.t('web.firms.openAlert') }}</a>
                  }
                  @if (r.url) {
                    <a [href]="r.url" target="_blank" rel="noopener" class="text-sky-700 underline">{{ i18n.t('web.topics.source') }}</a>
                  }
                </div>
                <ul class="mt-1 text-start text-slate-600" lang="en" dir="ltr">
                  @for (line of r.details; track $index) {
                    <li>{{ line }}</li>
                  }
                </ul>
              </li>
            } @empty {
              <li class="py-2 text-slate-600">{{ i18n.t('web.firms.noRecords') }}</li>
            }
          </ul>
        </ng-template>
        <ng-container *ngTemplateOutlet="recordList; context: { $implicit: records().recent }" />
        @if (records().older.length > 0) {
          <details class="mt-2">
            <summary class="cursor-pointer text-sm text-sky-700">{{ i18n.t('web.firms.history', { count: records().older.length }) }}</summary>
            <ng-container *ngTemplateOutlet="recordList; context: { $implicit: records().older }" />
          </details>
        }
      </section>
      <app-data-dates [freshness]="p.freshness" />
    } @else {
      <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class FirmProfile {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  private readonly http = inject(HttpClient);
  readonly id = input.required<string>();
  /** The name searched for, kept with the firm when it is watched. */
  readonly q = input<string>();
  protected readonly disputeKinds = DISPUTE_KINDS;

  /** The id the user agreed to spend a lookup on; the profile loads only once it matches the page's. */
  private readonly confirmedId = signal<string | null>(null);
  protected readonly confirmed = computed(() => opened.has(this.id()) || this.confirmedId() === this.id());
  protected readonly profile = httpResource<FirmProfileResponse>(() =>
    this.confirmed() ? apiUrl(`/v1/firms/${encodeURIComponent(this.id())}`) : undefined,
  );

  /** Refusals, listings and failed tests as one list, newest first, split at three years. */
  protected readonly records = computed(() => {
    const p = this.profile.hasValue() ? this.profile.value() : null;
    const rows: RecordRow[] = [
      ...(p?.refusals ?? []).map((r) => ({
        key: `r${r.id}`,
        date: r.refusalDate,
        label: this.i18n.t('web.noticeSource.fda_refusal'),
        details: [r.productDesc ?? r.productCode ?? '', ...r.charges.map((c) => (c.name ? `${c.code}: ${c.name}` : c.code))].filter(Boolean),
        url: r.url,
      })),
      ...(p?.listings ?? []).map((l) => ({
        key: `l${l.id}`,
        date: l.listedOn,
        label: this.i18n.t(l.list === 'red' ? 'web.firms.listingRed' : 'web.firms.listingGreen', { alert: l.alertNumber }),
        details: [l.alertTitle, ...l.products.map((x) => x.productName ?? x.productCode ?? '').filter(Boolean)],
        url: l.url,
        alert: l.alertNumber,
        removedOn: l.removedOn,
      })),
      ...(p?.auFailures ?? []).map((f) => ({
        key: `a${f.id}`,
        date: f.failedOn ?? `${f.reportMonth}-01`,
        label: this.i18n.t('web.noticeSource.au_ifis'),
        details: [f.productDesc, f.testApplied, f.reason, f.resultText].filter((x): x is string => !!x),
        url: f.url,
      })),
    ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const cutoff = threeYearsAgo();
    // A record without a date stays with the recent ones rather than being hidden under History.
    return { recent: rows.filter((r) => r.date === null || r.date >= cutoff), older: rows.filter((r) => r.date !== null && r.date < cutoff) };
  });

  protected readonly busy = signal(false);
  /** The outcome of the last action, kept with the firm it was for. */
  protected readonly result = signal<{ id: string; kind: 'success' | 'error'; text: string } | null>(null);
  protected readonly disputeOpen = signal(false);
  protected disputeKind = 'wrong_details';
  protected disputeMessage = '';

  protected open(): void {
    opened.add(this.id());
    this.confirmedId.set(this.id());
  }

  protected place(p: FirmProfileResponse): string {
    const a = p.address;
    return [a.line, a.city, a.region, a.postalCode, a.countryCode ? this.taxonomy.label('country', a.countryCode) : null].filter(Boolean).join(', ');
  }

  protected hazardGroups(categories: string[]): string {
    return categories.map((c) => this.taxonomy.label('hazardCategory', c)).join(', ');
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected watch(p: FirmProfileResponse): void {
    const body: CreateWatchlistItemRequest = { kind: 'firm', firmId: p.id, inputName: this.q()?.trim() || undefined };
    void this.act(async () => {
      await firstValueFrom(this.http.post(apiUrl('/v1/watchlist'), body));
      return this.i18n.t('web.firms.watched');
    });
  }

  protected downloadPdf(p: FirmProfileResponse): void {
    void this.act(async () => {
      await downloadFile(this.http, apiUrl(`/v1/firms/${p.id}/report.pdf`), new HttpParams(), `rejectradar-firm-${p.id}.pdf`);
      return null;
    });
  }

  protected sendDispute(p: FirmProfileResponse): void {
    const body: CreateDisputeRequest = { kind: this.disputeKind as CreateDisputeRequest['kind'], message: this.disputeMessage.trim() };
    void this.act(async () => {
      await firstValueFrom(this.http.post(apiUrl(`/v1/firms/${p.id}/disputes`), body));
      this.disputeOpen.set(false);
      this.disputeMessage = '';
      return this.i18n.t('web.firms.disputeSent');
    });
  }

  /** Runs one action at a time; its message, if any, is kept with the firm it was for. */
  private async act(action: () => Promise<string | null>): Promise<void> {
    if (this.busy()) return;
    const id = this.id();
    this.busy.set(true);
    this.result.set(null);
    try {
      const text = await action();
      if (text) this.result.set({ id, kind: 'success', text });
    } catch (error) {
      this.result.set({ id, kind: 'error', text: errorMessage(this.i18n, error) });
    } finally {
      this.busy.set(false);
    }
  }
}
