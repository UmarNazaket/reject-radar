import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import type { ImportAlertSummaryContent, SummaryReviewItem, SummaryReviewResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { adminTime } from './admin-format';

const STATUSES = ['draft', 'approved', 'rejected'] as const;
const MAX_WORDS = 120;

interface Draft {
  summary: string;
  whatTriggersListing: string;
  howFirmsGetRemoved: string;
  /** One test per line. */
  tests: string;
}

const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** The English Import Alert summaries Claude drafts, beside FDA's text: approve as is, correct and approve, or reject. */
@Component({
  selector: 'app-admin-summaries',
  imports: [FormsModule, RouterLink, MatButtonModule, Alert],
  template: `
    <nav class="flex gap-1 text-sm" aria-label="Summary status">
      @for (s of statuses; track s) {
        <a routerLink="." [queryParams]="{ status: s === 'draft' ? null : s }" class="rounded-md px-3 py-1.5 capitalize" [class.bg-slate-200]="shown() === s">{{ s }}</a>
      }
    </nav>
    @if (action.error(); as error) {
      <app-alert class="mt-4 block">{{ error }}</app-alert>
    }
    @if (list.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (list.hasValue()) {
      <ul class="mt-4 flex flex-col gap-4">
        @for (item of items(); track item.number) {
          <li class="rounded-lg border border-slate-200 bg-white p-4">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <a [routerLink]="['/import-alerts', item.number]" class="font-medium text-sky-700 underline">Import Alert {{ item.number }}</a>
              <span class="text-sm text-slate-600">{{ item.title }}</span>
              <span class="ms-auto text-sm text-slate-600">{{ item.status }} · {{ item.model }} · {{ time(item.reviewedAt ?? item.updatedAt) }}</span>
            </div>
            @if (!item.current) {
              <app-alert kind="warn" class="mt-3 block">FDA changed the alert text after this summary was drafted, so it cannot be approved. A new draft follows with the next run.</app-alert>
            }
            <div class="mt-3 grid gap-4 lg:grid-cols-2">
              <section>
                <h3 class="text-sm font-medium text-slate-700">Summary</h3>
                @if (editing() === item.number) {
                  <form #f="ngForm" class="mt-1 flex flex-col gap-2 text-sm" (ngSubmit)="f.valid && approve(item, draft())">
                    <label>Summary ({{ wordCount() }} of {{ maxWords }} words)<textarea name="summary" required rows="4" class="mt-1 w-full rounded border border-slate-300 p-2" [(ngModel)]="draft().summary"></textarea></label>
                    <label>What gets a firm listed<textarea name="triggers" required rows="2" class="mt-1 w-full rounded border border-slate-300 p-2" [(ngModel)]="draft().whatTriggersListing"></textarea></label>
                    <label>How a firm gets removed<textarea name="removal" required rows="2" class="mt-1 w-full rounded border border-slate-300 p-2" [(ngModel)]="draft().howFirmsGetRemoved"></textarea></label>
                    <label>Tests mentioned, one per line<textarea name="tests" rows="2" class="mt-1 w-full rounded border border-slate-300 p-2" [(ngModel)]="draft().tests"></textarea></label>
                    <div class="flex gap-2">
                      <button matButton="filled" type="submit" [disabled]="action.busy() || wordCount() > maxWords">Approve corrected</button>
                      <button matButton type="button" (click)="editing.set(null)">Cancel</button>
                    </div>
                  </form>
                } @else {
                  <p class="mt-1">{{ item.content.summary }}</p>
                  <h4 class="mt-3 text-sm font-medium text-slate-700">What gets a firm listed</h4>
                  <p class="mt-1">{{ item.content.whatTriggersListing }}</p>
                  <h4 class="mt-3 text-sm font-medium text-slate-700">How a firm gets removed</h4>
                  <p class="mt-1">{{ item.content.howFirmsGetRemoved }}</p>
                  @if (item.content.testsMentioned.length > 0) {
                    <h4 class="mt-3 text-sm font-medium text-slate-700">Tests mentioned</h4>
                    <ul class="mt-1 list-disc ps-5">
                      @for (test of item.content.testsMentioned; track $index) {
                        <li>{{ test }}</li>
                      }
                    </ul>
                  }
                  <div class="mt-4 flex flex-wrap gap-2">
                    @if (item.status !== 'approved') {
                      <button matButton="filled" type="button" [disabled]="action.busy() || !item.current" (click)="approve(item)">Approve</button>
                    }
                    <button matButton="outlined" type="button" [disabled]="action.busy() || !item.current" (click)="startEdit(item)">Correct and approve</button>
                    @if (item.status !== 'rejected') {
                      <button matButton type="button" [disabled]="action.busy()" (click)="reject(item)">Reject</button>
                    }
                  </div>
                }
              </section>
              <section class="text-sm">
                <h3 class="font-medium text-slate-700">FDA's text</h3>
                @for (part of fdaText(item); track part.label) {
                  <h4 class="mt-2 font-medium text-slate-600">{{ part.label }}</h4>
                  <p class="mt-1 whitespace-pre-line">{{ part.text }}</p>
                }
                <a [href]="item.url" target="_blank" rel="noopener" class="mt-2 inline-block text-sky-700 underline">On the FDA website</a>
              </section>
            </div>
          </li>
        } @empty {
          <li class="rounded-lg border border-slate-200 bg-white p-6 text-slate-600">No {{ shown() }} summaries.</li>
        }
      </ul>
    } @else {
      <p class="mt-4 text-slate-600">Loading…</p>
    }
  `,
})
export class AdminSummaries {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  protected readonly statuses = STATUSES;
  protected readonly maxWords = MAX_WORDS;
  protected readonly time = adminTime;

  /** `?status=`: draft by default. */
  readonly status = input<string>();
  protected readonly shown = computed(() => (STATUSES as readonly string[]).includes(this.status() ?? '') ? (this.status() as string) : 'draft');
  protected readonly list = httpResource<SummaryReviewResponse>(() => ({ url: apiUrl('/v1/admin/import-alert-summaries'), params: { status: this.shown() } }));
  /** The list shown; a decided summary leaves it, as it no longer has this status. */
  protected readonly items = linkedSignal(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly action = new FormState(this.i18n);
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal<Draft>({ summary: '', whatTriggersListing: '', howFirmsGetRemoved: '', tests: '' });
  // A method, not a computed: ngModel writes into the draft object without setting the signal.
  protected wordCount(): number {
    return words(this.draft().summary);
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected fdaText(item: SummaryReviewItem): { label: string; text: string }[] {
    const parts = [
      { label: 'Reason for alert', text: item.reasonText },
      { label: 'Guidance', text: item.guidanceText },
      { label: 'Products', text: item.productText },
      { label: 'Charge', text: item.chargeText },
    ];
    return parts.filter((part): part is { label: string; text: string } => !!part.text);
  }

  protected startEdit(item: SummaryReviewItem): void {
    const c = item.content;
    this.draft.set({ summary: c.summary, whatTriggersListing: c.whatTriggersListing, howFirmsGetRemoved: c.howFirmsGetRemoved, tests: c.testsMentioned.join('\n') });
    this.editing.set(item.number);
  }

  protected approve(item: SummaryReviewItem, draft?: Draft): void {
    const content: ImportAlertSummaryContent | undefined = draft && {
      summary: draft.summary.trim(),
      whatTriggersListing: draft.whatTriggersListing.trim(),
      howFirmsGetRemoved: draft.howFirmsGetRemoved.trim(),
      testsMentioned: draft.tests.split('\n').map((t) => t.trim()).filter(Boolean),
    };
    void this.decide(item, content ? { action: 'approve', content } : { action: 'approve' });
  }

  protected reject(item: SummaryReviewItem): void {
    if (confirm(`Reject the summary of Import Alert ${item.number}? Customers will no longer see it.`)) void this.decide(item, { action: 'reject' });
  }

  private decide(item: SummaryReviewItem, body: object): Promise<void> {
    return this.action.run(async () => {
      await firstValueFrom(this.http.patch(apiUrl(`/v1/admin/import-alert-summaries/${encodeURIComponent(item.number)}`), body));
      this.editing.set(null);
      this.items.update((items) => items.filter((i) => i.number !== item.number));
    });
  }
}
