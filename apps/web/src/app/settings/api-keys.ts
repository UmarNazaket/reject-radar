import { HttpClient, httpResource } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { ApiKeysResponse, CreatedApiKeyResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Alert } from '../layout/alert';

/** Keys for the public API: created by owners and admins, shown in full once, revoked at any time. */
@Component({
  selector: 'app-api-keys',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, Alert],
  template: `
    <p class="max-w-2xl text-sm text-slate-600">{{ i18n.t('web.apiKeys.intro') }}</p>
    @if (action.error(); as error) {
      <app-alert class="mt-4 block">{{ error }}</app-alert>
    }
    @if (created(); as k) {
      <app-alert kind="success" class="mt-4 block">
        <p>{{ i18n.t('web.apiKeys.created', { name: k.name }) }}</p>
        <code class="mt-2 block rounded bg-white p-2 break-all" dir="ltr">{{ k.key }}</code>
        <button matButton type="button" class="mt-2" (click)="copy(k.key)">{{ copied() ? i18n.t('web.apiKeys.copied') : i18n.t('web.apiKeys.copy') }}</button>
      </app-alert>
    }
    @if (keys.error(); as error) {
      <app-alert class="mt-4 block">{{ errorText(error) }}</app-alert>
    } @else if (keys.hasValue()) {
      <form #f="ngForm" class="mt-4 flex max-w-2xl flex-wrap items-start gap-3" (ngSubmit)="f.valid && create(f)">
        <mat-form-field class="min-w-64 flex-1">
          <mat-label>{{ i18n.t('web.apiKeys.name') }}</mat-label>
          <input matInput name="name" required maxlength="100" [(ngModel)]="name" />
          <mat-error>{{ i18n.t('web.validation.required') }}</mat-error>
        </mat-form-field>
        <button matButton="filled" type="submit" class="mt-2" [disabled]="action.busy()">{{ i18n.t('web.apiKeys.create') }}</button>
      </form>
      <ul class="max-w-2xl divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        @for (k of keys.value().keys; track k.id) {
          <li class="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
            <div class="min-w-0 flex-1">
              <p class="font-medium">{{ k.name }} <code class="ms-2 text-slate-600" dir="ltr">{{ k.prefix }}…</code></p>
              <p class="text-slate-600">
                {{ i18n.t('web.apiKeys.createdBy', { name: k.createdByName ?? '—', date: i18n.date(k.createdAt) }) }} ·
                {{ k.lastUsedAt ? i18n.t('web.apiKeys.lastUsed', { date: i18n.date(k.lastUsedAt) }) : i18n.t('web.apiKeys.neverUsed') }}
              </p>
            </div>
            @if (k.revokedAt) {
              <span>{{ i18n.t('web.apiKeys.revoked', { date: i18n.date(k.revokedAt) }) }}</span>
            } @else {
              <button matButton type="button" [disabled]="action.busy()" (click)="revoke(k.id)">{{ i18n.t('web.team.revoke') }}</button>
            }
          </li>
        } @empty {
          <li class="p-4 text-sm text-slate-600">{{ i18n.t('web.apiKeys.none') }}</li>
        }
      </ul>
    } @else {
      <p class="mt-4 text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class ApiKeys {
  protected readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  protected readonly keys = httpResource<ApiKeysResponse>(() => apiUrl('/v1/org/api-keys'));
  protected readonly action = new FormState(this.i18n);
  /** The key just created: the only time its full value is shown. */
  protected readonly created = signal<CreatedApiKeyResponse | null>(null);
  protected readonly copied = signal(false);
  protected name = '';

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected create(form: { resetForm: () => void }): void {
    this.created.set(null);
    this.copied.set(false);
    const name = this.name.trim();
    void this.action.run(async () => {
      this.created.set(await firstValueFrom(this.http.post<CreatedApiKeyResponse>(apiUrl('/v1/org/api-keys'), { name })));
      form.resetForm();
      this.keys.reload();
    });
  }

  protected revoke(id: string): void {
    if (!confirm(this.i18n.t('web.apiKeys.revokeConfirm'))) return;
    void this.action.run(async () => {
      await firstValueFrom(this.http.delete(apiUrl(`/v1/org/api-keys/${id}`)));
      this.keys.reload();
    });
  }

  protected copy(key: string): void {
    void navigator.clipboard.writeText(key).then(() => this.copied.set(true));
  }
}
