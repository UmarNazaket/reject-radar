import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { MATCH_REVIEW_STATUSES, type MatchReviewItem, type MatchReviewsResponse, type MatchReviewStatus } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { AdminFirmCard } from './admin-firm-card';
import { adminError, adminTime, RECORD_SOURCE_LABELS } from './admin-format';

const STATUS_LABELS: Record<MatchReviewStatus, string> = { open: 'Open', linked: 'Same firm', kept_separate: 'Different firms' };

/** Records the matcher was unsure about: staff say whether the record's firm and the candidate are the same firm. */
@Component({
  selector: 'app-admin-match-reviews',
  imports: [RouterLink, MatButtonModule, Alert, AdminFirmCard],
  template: `
    <nav class="flex gap-1 text-sm" aria-label="Review status">
      @for (s of statuses; track s) {
        <a routerLink="." [queryParams]="{ status: s === 'open' ? null : s }" class="rounded-md px-3 py-1.5" [class.bg-slate-200]="shown() === s">{{ labels[s] }}</a>
      }
    </nav>
    @if (action.error(); as error) {
      <app-alert class="mt-4 block">{{ error }}</app-alert>
    }
    @if (list.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (list.hasValue()) {
      <ul class="mt-4 flex flex-col gap-4">
        @for (item of list.value().items; track item.id) {
          <li class="rounded-lg border border-slate-200 bg-white p-4">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
              <span class="font-medium text-slate-900">{{ sources[item.source] }} {{ item.sourceKey }}</span>
              <span>Score {{ item.score }}</span>
              <span>{{ item.reason === 'second_fei' ? 'Would give a firm a second FEI' : 'Score in the review band' }}</span>
              <span class="ms-auto">{{ time(item.decidedAt ?? item.createdAt) }}</span>
            </div>
            <div class="mt-3 grid gap-3 md:grid-cols-2">
              <app-admin-firm-card [firm]="item.firm" heading="Record's firm" />
              <app-admin-firm-card [firm]="item.candidate" heading="Candidate" />
            </div>
            <details class="mt-3 text-sm">
              <summary class="cursor-pointer text-sky-700">Evidence</summary>
              <pre class="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{{ json(item.evidence) }}</pre>
            </details>
            @if (item.status === 'open') {
              <div class="mt-4 flex flex-wrap gap-2">
                <button matButton="filled" type="button" [disabled]="action.busy()" (click)="decide(item, true)">Same firm</button>
                <button matButton="outlined" type="button" [disabled]="action.busy()" (click)="decide(item, false)">Different firms</button>
              </div>
            }
          </li>
        } @empty {
          <li class="rounded-lg border border-slate-200 bg-white p-6 text-slate-600">No reviews here.</li>
        }
      </ul>
    } @else {
      <p class="mt-4 text-slate-600">Loading…</p>
    }
  `,
})
export class AdminMatchReviews {
  private readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  protected readonly statuses = MATCH_REVIEW_STATUSES;
  protected readonly labels = STATUS_LABELS;
  protected readonly sources = RECORD_SOURCE_LABELS;
  protected readonly time = adminTime;

  /** `?status=`: open by default. */
  readonly status = input<string>();
  protected readonly shown = computed<MatchReviewStatus>(() => MATCH_REVIEW_STATUSES.find((s) => s === this.status()) ?? 'open');
  protected readonly list = httpResource<MatchReviewsResponse>(() => ({ url: apiUrl('/v1/admin/match-reviews'), params: { status: this.shown() } }));
  protected readonly action = new FormState(this.i18n, adminError);

  protected errorText(error: unknown): string {
    return adminError(this.i18n, error);
  }

  protected json(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  protected decide(item: MatchReviewItem, same: boolean): void {
    const question = same
      ? `Merge firm ${item.candidate.id} and firm ${item.firm.id}? The older firm keeps every record, watchlist item and alert of the other.`
      : `Keep firm ${item.firm.id} and firm ${item.candidate.id} apart?`;
    if (!confirm(question)) return;
    void this.action.run(async () => {
      await firstValueFrom(this.http.post(apiUrl(`/v1/admin/match-reviews/${item.id}/decision`), { same }));
      // A merge also decides, and re-points, the other reviews between the two firms.
      this.list.reload();
    });
  }
}
