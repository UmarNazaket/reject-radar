import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import {
  type AdminDisputeItem,
  type DecideDisputeResponse,
  DISPUTE_STATUSES,
  type DisputeKind,
  type DisputeReviewResponse,
  type DisputeStatus,
} from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { AdminFirmCard } from './admin-firm-card';
import { adminError, adminTime, RECORD_SOURCE_LABELS } from './admin-format';

const STATUS_LABELS: Record<DisputeStatus, string> = { open: 'Open', resolved: 'Resolved', rejected: 'Rejected' };
const TABS: readonly DisputeStatus[] = ['open', 'resolved', 'rejected'];
const KIND_LABELS: Record<DisputeKind, string> = {
  wrong_firm: 'A record belongs to another firm',
  mixed_firms: 'Two different firms are mixed together',
  wrong_details: "The firm's details are wrong",
  other: 'Something else',
};

/** What customers reported with "Report a problem": staff fix it with the firm tools, then resolve or reject it with a note the customer is emailed. */
@Component({
  selector: 'app-admin-disputes',
  imports: [RouterLink, MatButtonModule, Alert, AdminFirmCard],
  template: `
    <nav class="flex gap-1 text-sm" aria-label="Dispute status">
      @for (s of statuses; track s) {
        <a routerLink="." [queryParams]="{ status: s === 'open' ? null : s }" class="rounded-md px-3 py-1.5" [class.bg-slate-200]="shown() === s">{{ labels[s] }}</a>
      }
    </nav>
    @if (action.error(); as error) {
      <app-alert class="mt-4 block">{{ error }}</app-alert>
    }
    @if (done(); as text) {
      <app-alert kind="success" class="mt-4 block">{{ text }}</app-alert>
    }
    @if (list.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (list.hasValue()) {
      <ul class="mt-4 flex flex-col gap-4">
        @for (item of list.value().items; track item.id) {
          <li class="rounded-lg border border-slate-200 bg-white p-4">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
              <span class="font-medium text-slate-900">{{ kinds[item.kind] }}</span>
              <span><bdi>{{ item.org.name }}</bdi></span>
              @if (item.reporter; as r) {
                <span><bdi>{{ r.name }}</bdi> ({{ r.email }})</span>
              } @else {
                <span>Reporter has left</span>
              }
              <span class="ms-auto">{{ time(item.createdAt) }}</span>
            </div>
            <div class="mt-3 grid gap-3 md:grid-cols-2">
              <section class="text-sm">
                <h3 class="text-slate-600">What the customer wrote</h3>
                <p class="mt-1 whitespace-pre-line" dir="auto">{{ item.message }}</p>
                @if (item.record; as rec) {
                  <p class="mt-2 text-slate-600">About {{ sources[rec.source] }} {{ rec.key }}</p>
                }
              </section>
              <app-admin-firm-card [firm]="item.firm" heading="Firm" />
            </div>
            @if (item.status === 'open') {
              <div class="mt-4 text-sm">
                <label [for]="'note-' + item.id" class="font-medium text-slate-700">Note to the customer</label>
                <textarea #note [id]="'note-' + item.id" rows="2" maxlength="2000" class="mt-1 block w-full rounded border border-slate-300 p-2"></textarea>
                <div class="mt-2 flex flex-wrap gap-2">
                  <button matButton="filled" type="button" [disabled]="action.busy()" (click)="decide(item, 'resolved', note.value)">Resolve</button>
                  <button matButton="outlined" type="button" [disabled]="action.busy()" (click)="decide(item, 'rejected', note.value)">Reject</button>
                </div>
              </div>
            } @else {
              <section class="mt-3 text-sm">
                <h3 class="text-slate-600">{{ labels[item.status] }} {{ item.resolvedAt ? time(item.resolvedAt) : '' }}</h3>
                <p class="mt-1 whitespace-pre-line">{{ item.resolution }}</p>
              </section>
            }
          </li>
        } @empty {
          <li class="rounded-lg border border-slate-200 bg-white p-6 text-slate-600">No disputes here.</li>
        }
      </ul>
    } @else {
      <p class="mt-4 text-slate-600">Loading…</p>
    }
  `,
})
export class AdminDisputes {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  protected readonly statuses = TABS;
  protected readonly labels = STATUS_LABELS;
  protected readonly kinds = KIND_LABELS;
  protected readonly sources = RECORD_SOURCE_LABELS;
  protected readonly time = adminTime;

  /** `?status=`: open by default. */
  readonly status = input<string>();
  protected readonly shown = computed<DisputeStatus>(() => DISPUTE_STATUSES.find((s) => s === this.status()) ?? 'open');
  protected readonly list = httpResource<DisputeReviewResponse>(() => ({ url: apiUrl('/v1/admin/disputes'), params: { status: this.shown() } }));
  protected readonly action = new FormState(this.i18n, adminError);
  /** What the last decision did; cleared on another tab. */
  protected readonly done = linkedSignal<DisputeStatus, string | null>({ source: this.shown, computation: () => null });

  protected errorText(error: unknown): string {
    return adminError(this.i18n, error);
  }

  protected decide(item: AdminDisputeItem, status: 'resolved' | 'rejected', note: string): void {
    const resolution = note.trim();
    this.done.set(null);
    if (!resolution) {
      this.action.error.set('Write a note for the customer first.');
      return;
    }
    const verb = status === 'resolved' ? 'Resolve' : 'Reject';
    const who = item.reporter ? ` ${item.reporter.email} will be emailed the note.` : '';
    if (!confirm(`${verb} this dispute about ${item.firm.displayName}?${who}`)) return;
    void this.action.run(async () => {
      const result = await firstValueFrom(this.http.patch<DecideDisputeResponse>(apiUrl(`/v1/admin/disputes/${item.id}`), { status, resolution }));
      const email = result.emailed ? 'The customer was emailed.' : 'The email to the customer was not sent.';
      this.done.set(`${status === 'resolved' ? 'Resolved' : 'Rejected'}. ${email}`);
      this.list.reload();
    });
  }
}
