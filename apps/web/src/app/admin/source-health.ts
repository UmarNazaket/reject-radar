import { httpResource } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { type AdminSourcesResponse, EMAIL_CAP_TIERS, type SyncSource } from '@rejectradar/contracts';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';
import { adminTime } from './admin-format';

const SOURCE_NAMES: Record<SyncSource, string> = {
  fda_charge_codes: 'FDA charge codes',
  fda_refusals: 'FDA import refusals',
  import_alerts: 'FDA Import Alerts',
  rasff: 'EU RASFF',
  uk_bn: 'UK border notifications',
  au_ifis: 'Australian failed tests',
  eu_mrl: 'EU pesticide limits (MRL)',
};

/** Each source's last good sync, whether it is stale, and its newest runs with their counts and errors. */
@Component({
  selector: 'app-source-health',
  imports: [Alert],
  template: `
    @if (sources.error(); as error) {
      <app-alert>{{ errorText(error) }}</app-alert>
    } @else if (sources.hasValue()) {
      @let usage = sources.value();
      <dl class="mb-4 grid gap-3 text-sm sm:grid-cols-2">
        <div class="rounded-lg border bg-white p-4" [class]="border(usage.database.sizeBytes, usage.database.limitBytes)">
          <dt class="text-slate-600">Database size</dt>
          <dd class="mt-1 font-medium">{{ megabytes(usage.database.sizeBytes) }} MB of {{ megabytes(usage.database.limitBytes) }} MB; the syncs stop at the limit</dd>
        </div>
        <div class="rounded-lg border bg-white p-4" [class]="border(usage.emails.sentToday, usage.emails.cap)">
          <dt class="text-slate-600">Emails today (UTC)</dt>
          <dd class="mt-1 font-medium">
            {{ usage.emails.sentToday }} of {{ usage.emails.cap }}; instant alerts pause at {{ tiers.instant }}, digests at {{ tiers.digest }}
          </dd>
        </div>
      </dl>
      <ul class="flex flex-col gap-3">
        @for (s of sources.value().sources; track s.source) {
          <li class="rounded-lg border border-slate-200 bg-white p-4">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
              <h2 class="font-medium">{{ names[s.source] }}</h2>
              @if (s.freshness; as f) {
                <span class="text-sm text-slate-600">Last good sync: {{ f.lastSuccessAt ? time(f.lastSuccessAt) : 'never' }}</span>
                @if (f.latestMonth) {
                  <span class="text-sm text-slate-600">Newest month: {{ f.latestMonth }}</span>
                }
                @if (f.stale) {
                  <span class="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">Stale</span>
                }
              }
              @if (s.runs[0]; as last) {
                @if (last.status === 'failed') {
                  <span class="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-800">Last run failed</span>
                } @else if (last.status === 'running') {
                  <span class="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-800">Running</span>
                }
              }
            </div>
            @if (s.runs[0]?.error; as error) {
              <p class="mt-2 text-sm break-words text-red-800">{{ error }}</p>
            }
            @if (s.runs.length > 0) {
              <details class="mt-2">
                <summary class="cursor-pointer text-sm text-sky-700">Recent runs ({{ s.runs.length }})</summary>
                <div class="mt-2 overflow-x-auto">
                  <table class="w-full text-sm">
                    <thead class="text-slate-600">
                      <tr class="border-b border-slate-200">
                        <th scope="col" class="py-2 pe-4 text-start font-medium">Started</th>
                        <th scope="col" class="py-2 pe-4 text-start font-medium">Status</th>
                        <th scope="col" class="py-2 pe-4 text-end font-medium">Read</th>
                        <th scope="col" class="py-2 pe-4 text-end font-medium">Inserted</th>
                        <th scope="col" class="py-2 pe-4 text-end font-medium">Updated</th>
                        <th scope="col" class="py-2 pe-4 text-end font-medium">Deleted</th>
                        <th scope="col" class="py-2 pe-4 text-end font-medium">Events</th>
                        <th scope="col" class="py-2 text-start font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of s.runs; track r.id) {
                        <tr class="border-b border-slate-100 align-top">
                          <td class="py-2 pe-4 whitespace-nowrap">{{ time(r.startedAt) }}</td>
                          <td class="py-2 pe-4">{{ r.status }}{{ r.partial ? ' (partial)' : '' }}</td>
                          <td class="py-2 pe-4 text-end">{{ r.rowsRead }}</td>
                          <td class="py-2 pe-4 text-end">{{ r.rowsInserted }}</td>
                          <td class="py-2 pe-4 text-end">{{ r.rowsUpdated }}</td>
                          <td class="py-2 pe-4 text-end">{{ r.rowsDeleted }}</td>
                          <td class="py-2 pe-4 text-end">{{ r.eventsEmitted }}</td>
                          <td class="py-2 break-words text-red-800">{{ r.error ?? '' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </details>
            } @else {
              <p class="mt-2 text-sm text-slate-600">No runs yet.</p>
            }
          </li>
        }
      </ul>
    } @else {
      <p class="text-slate-600">Loading…</p>
    }
  `,
})
export class SourceHealth {
  private readonly i18n = inject(I18n);
  protected readonly names = SOURCE_NAMES;
  protected readonly sources = httpResource<AdminSourcesResponse>(() => apiUrl('/v1/admin/sources'));
  protected readonly time = adminTime;
  protected readonly tiers = EMAIL_CAP_TIERS;

  protected megabytes(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1);
  }

  /** At 80% of a limit the box turns amber, before the syncs or emails stop. */
  protected border(used: number, limit: number): string {
    return used >= limit * 0.8 ? 'border-amber-400' : 'border-slate-200';
  }

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }
}
