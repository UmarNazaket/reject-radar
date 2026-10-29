import { HttpClient, HttpErrorResponse, HttpParams, httpResource } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import type { BulkJobListResponse, BulkJobResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { downloadFile } from '../core/download';
import { errorMessage } from '../core/errors';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';

/** What the API lists when a file's header or rows are wrong (`INVALID_HEADER`, `INVALID_ROWS`). */
interface UploadProblems {
  missing?: string[];
  count?: number;
  problems?: { row: number; column: string; problem: string }[];
}

/** Bulk screening: the template, the upload, and the account's jobs. */
@Component({
  selector: 'app-bulk-jobs',
  imports: [RouterLink, MatButtonModule, Alert],
  template: `
    <h1 class="text-2xl font-semibold">{{ i18n.t('web.bulk.title') }}</h1>
    <p class="mt-1 text-slate-600">{{ i18n.t('web.bulk.intro') }}</p>

    <section class="mt-6 max-w-2xl rounded-lg border border-slate-200 bg-white p-4">
      <ol class="list-decimal ps-5 text-sm text-slate-700">
        <li>{{ i18n.t('web.bulk.step1') }}</li>
        <li>{{ i18n.t('web.bulk.step2') }}</li>
        <li>{{ i18n.t('web.bulk.step3') }}</li>
      </ol>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button matButton="outlined" type="button" [disabled]="upload.busy()" (click)="downloadTemplate()">{{ i18n.t('web.bulk.template') }}</button>
        <input #file type="file" accept=".csv,text/csv" class="hidden" (change)="send(file)" />
        <button matButton="filled" type="button" [disabled]="upload.busy()" (click)="file.click()">
          {{ upload.busy() ? i18n.t('web.bulk.uploading') : i18n.t('web.bulk.upload') }}
        </button>
      </div>
      @if (upload.error(); as error) {
        <app-alert class="mt-4 block">
          {{ error }}
          @if (problems(); as p) {
            @if (p.missing) {
              <p class="mt-1">{{ i18n.t('web.bulk.missing', { columns: p.missing.join(', ') }) }}</p>
            }
            @if (p.problems && p.problems.length > 0) {
              <ul class="mt-2 list-disc ps-5">
                @for (x of p.problems; track $index) {
                  <li>{{ i18n.t('web.bulk.problem', { row: x.row, column: x.column, problem: i18n.t('web.bulk.problems.' + x.problem) }) }}</li>
                }
              </ul>
              @if ((p.count ?? 0) > p.problems.length) {
                <p class="mt-1">{{ i18n.t('web.bulk.moreProblems', { count: (p.count ?? 0) - p.problems.length }) }}</p>
              }
            }
          }
        </app-alert>
      }
    </section>

    <section class="mt-6">
      <h2 class="mb-3 font-medium">{{ i18n.t('web.bulk.jobs') }}</h2>
      @if (jobs.error(); as error) {
        <app-alert>{{ errorText(error) }}</app-alert>
      } @else if (jobs.hasValue()) {
        <ul class="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          @for (job of jobs.value().jobs; track job.id) {
            <li class="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
              <a [routerLink]="['/bulk', job.id]" class="font-medium text-sky-700 underline" dir="ltr">{{ job.fileName }}</a>
              <span>{{ i18n.t('web.bulk.status.' + job.status) }}</span>
              <span class="text-slate-600">{{ i18n.t('web.bulk.progress', { processed: job.processed, total: job.total }) }}</span>
              <span class="ms-auto text-slate-600">{{ i18n.date(job.createdAt) }}</span>
            </li>
          } @empty {
            <li class="p-6 text-slate-600">{{ i18n.t('web.bulk.noJobs') }}</li>
          }
        </ul>
      } @else {
        <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
      }
    </section>
  `,
})
export class BulkJobs {
  protected readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly jobs = httpResource<BulkJobListResponse>(() => apiUrl('/v1/bulk-jobs'));
  protected readonly upload = new FormState(this.i18n);
  /** The header or row problems of the last refused upload. */
  protected readonly problems = signal<UploadProblems | null>(null);

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected downloadTemplate(): void {
    void this.upload.run(() => downloadFile(this.http, apiUrl('/v1/bulk-jobs/template.csv'), new HttpParams(), 'rejectradar-bulk-template.csv'));
  }

  /** Sends the chosen file as the request body; the API reads it as it arrives and answers with the new job. */
  protected send(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.problems.set(null);
    void this.upload.run(async () => {
      try {
        const job = await firstValueFrom(
          this.http.post<BulkJobResponse>(apiUrl('/v1/bulk-jobs'), file, { headers: { 'Content-Type': 'text/csv' }, params: { fileName: file.name } }),
        );
        await this.router.navigate(['/bulk', job.id]);
      } catch (error) {
        if (error instanceof HttpErrorResponse) this.problems.set((error.error as { details?: UploadProblems } | null)?.details ?? null);
        throw error;
      }
    });
  }
}
