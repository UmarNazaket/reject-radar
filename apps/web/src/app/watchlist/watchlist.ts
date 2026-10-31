import { HttpClient, HttpParams, httpResource } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import type { WatchlistItem, WatchlistResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { downloadFile } from '../core/download';
import { errorMessage } from '../core/errors';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { Alert } from '../layout/alert';

/** The account's watched firms and topics, each with its label, notes, latest record and unread alerts. */
@Component({
  selector: 'app-watchlist',
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule, Alert],
  template: `
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-2xl font-semibold">{{ i18n.t('web.watchlist.title') }}</h1>
      @if (list.hasValue()) {
        <span class="text-sm text-slate-600">{{ i18n.t('web.watchlist.used', { used: list.value().used, limit: list.value().limit }) }}</span>
        @if (list.value().items.length > 0) {
          <button matButton="outlined" type="button" class="ms-auto" [disabled]="action.busy()" (click)="exportCsv()">{{ i18n.t('web.watchlist.export') }}</button>
        }
      }
    </div>
    @if (action.error(); as error) {
      <app-alert class="mt-4 block" [upgrade]="action.upgrade()">{{ error }}</app-alert>
    }

    @if (list.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (list.hasValue()) {
      <ul class="mt-4 flex flex-col gap-3">
        @for (item of list.value().items; track item.id) {
          <li class="rounded-lg border border-slate-200 bg-white p-4">
            <div class="flex flex-wrap items-start gap-x-4 gap-y-1">
              <div class="min-w-0 flex-1">
                @if (item.firm; as firm) {
                  <a [routerLink]="['/firms', firm.id]" class="font-medium text-sky-700 underline" dir="auto">{{ firm.displayName }}</a>
                  <p class="mt-1 text-sm text-slate-600">
                    {{ firm.countryCode ? taxonomy.label('country', firm.countryCode) : '' }}
                    @if (firm.facts.import_alert_red.length > 0) {
                      · <span class="text-red-800">{{ i18n.t('web.watchlist.redList', { count: firm.facts.import_alert_red.length }) }}</span>
                    }
                    · {{ i18n.t('web.watchlist.refusals12m', { count: firm.facts.fda_refusals_12m }) }}
                  </p>
                }
                @if (item.topic; as topic) {
                  <a routerLink="/topics" [queryParams]="topicParams(item)" class="font-medium text-sky-700 underline">{{ topicName(item) }}</a>
                  <p class="mt-1 text-sm text-slate-600">{{ i18n.t('web.watchlist.notices12m', { count: topic.notices12m }) }}</p>
                }
                @if (item.label) {
                  <p class="mt-1 text-sm"><span class="text-slate-600">{{ i18n.t('web.watchlist.label') }}:</span> {{ item.label }}</p>
                }
                @if (item.notes) {
                  <p class="mt-1 text-sm whitespace-pre-line text-slate-700">{{ item.notes }}</p>
                }
                <p class="mt-1 text-sm text-slate-600">
                  {{ item.lastRecordOn ? i18n.t('web.firms.lastNotice', { date: i18n.date(item.lastRecordOn) }) : i18n.t('web.watchlist.noRecord') }}
                  ·
                  <a routerLink="/alerts" [queryParams]="alertParams(item)" class="text-sky-700 underline">{{ i18n.t('web.watchlist.alerts', { count: item.unreadAlerts }) }}</a>
                </p>
              </div>
              <div class="flex gap-1">
                <button matButton type="button" (click)="startEdit(item)">{{ i18n.t('web.watchlist.edit') }}</button>
                <button matButton type="button" [disabled]="action.busy()" (click)="remove(item)">{{ i18n.t('web.watchlist.remove') }}</button>
              </div>
            </div>
            @if (editing() === item.id) {
              <form #f="ngForm" class="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3" (ngSubmit)="f.valid && save(item)">
                <mat-form-field>
                  <mat-label>{{ i18n.t('web.watchlist.label') }}</mat-label>
                  <input matInput name="label" maxlength="100" [(ngModel)]="editLabel" />
                </mat-form-field>
                <mat-form-field>
                  <mat-label>{{ i18n.t('web.watchlist.notes') }}</mat-label>
                  <textarea matInput name="notes" rows="3" maxlength="1000" [(ngModel)]="editNotes"></textarea>
                </mat-form-field>
                <div class="flex gap-2">
                  <button matButton="filled" type="submit" [disabled]="action.busy()">{{ i18n.t('web.alerts.save') }}</button>
                  <button matButton type="button" (click)="editing.set(null)">{{ i18n.t('web.watchlist.cancel') }}</button>
                </div>
              </form>
            }
          </li>
        } @empty {
          <li class="rounded-lg border border-slate-200 bg-white p-6 text-slate-600">
            {{ i18n.t('web.watchlist.empty') }}
            <a routerLink="/firms" class="text-sky-700 underline">{{ i18n.t('web.nav.firms') }}</a> ·
            <a routerLink="/topics" class="text-sky-700 underline">{{ i18n.t('web.nav.topics') }}</a>
          </li>
        }
      </ul>
    } @else {
      <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class Watchlist {
  protected readonly i18n = inject(I18n);
  protected readonly taxonomy = inject(Taxonomy);
  private readonly http = inject(HttpClient);
  protected readonly list = httpResource<WatchlistResponse>(() => apiUrl('/v1/watchlist'));

  protected readonly action = new FormState(this.i18n);
  protected readonly editing = signal<string | null>(null);
  protected editLabel = '';
  protected editNotes = '';

  protected topicName(item: WatchlistItem): string {
    const t = item.topic;
    if (!t) return '';
    return [
      this.taxonomy.label('country', t.originCountry),
      t.commodityId ? this.taxonomy.label('commodity', t.commodityId) : this.i18n.t('web.topics.anyCommodity'),
      t.destination ? this.taxonomy.label('destination', t.destination) : this.i18n.t('web.topics.allDestinations'),
      ...(t.hazardId ? [this.taxonomy.label('hazard', t.hazardId)] : []),
    ].join(' · ');
  }

  protected topicParams(item: WatchlistItem): Record<string, string | number | null> {
    const t = item.topic;
    return { origin: t?.originCountry ?? null, commodity: t?.commodityId ?? null, destination: t?.destination ?? null };
  }

  /** The alerts page's filters for this item: its firm, or its topic's fields. */
  protected alertParams(item: WatchlistItem): Record<string, string | number | null> {
    if (item.firm) return { firm: item.firm.id };
    const t = item.topic;
    return { origin: t?.originCountry ?? null, commodity: t?.commodityId ?? null, destination: t?.destination ?? null, hazard: t?.hazardId ?? null };
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected startEdit(item: WatchlistItem): void {
    this.editLabel = item.label ?? '';
    this.editNotes = item.notes ?? '';
    this.editing.set(item.id);
  }

  protected save(item: WatchlistItem): void {
    // An emptied field is cleared on the API with null.
    const body = { label: this.editLabel.trim() || null, notes: this.editNotes.trim() || null };
    void this.action.run(async () => {
      await firstValueFrom(this.http.patch(apiUrl(`/v1/watchlist/${item.id}`), body));
      this.editing.set(null);
      this.list.reload();
    });
  }

  protected remove(item: WatchlistItem): void {
    if (!confirm(this.i18n.t('web.watchlist.removeConfirm'))) return;
    void this.action.run(async () => {
      await firstValueFrom(this.http.delete(apiUrl(`/v1/watchlist/${item.id}`)));
      this.list.reload();
    });
  }

  protected exportCsv(): void {
    void this.action.run(() => downloadFile(this.http, apiUrl('/v1/watchlist/export.csv'), new HttpParams(), 'rejectradar-watchlist.csv'));
  }

}
