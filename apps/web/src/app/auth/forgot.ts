import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { FORM_IMPORTS } from './form-imports';

@Component({
  selector: 'app-forgot',
  imports: [FORM_IMPORTS],
  template: `
    <h1 class="mb-2 text-xl font-semibold">{{ i18n.t('web.forgot.title') }}</h1>
    @if (sentTo(); as email) {
      <app-alert kind="success">{{ i18n.t('web.forgot.sent', { email }) }}</app-alert>
    } @else {
      <p class="mb-6 text-sm text-slate-600">{{ i18n.t('web.forgot.body') }}</p>
      <form #f="ngForm" class="flex flex-col gap-3" (ngSubmit)="f.valid && submit()">
        <mat-form-field>
          <mat-label>{{ i18n.t('web.auth.email') }}</mat-label>
          <input matInput type="email" name="email" autocomplete="email" required email [(ngModel)]="email" />
          <mat-error>{{ i18n.t('web.validation.email') }}</mat-error>
        </mat-form-field>
        @if (form.error(); as error) {
          <app-alert>{{ error }}</app-alert>
        }
        <button matButton="filled" type="submit" class="w-full" [disabled]="form.busy()">{{ i18n.t('web.forgot.submit') }}</button>
      </form>
    }
    <a routerLink="/login" class="mt-6 inline-block text-sm text-sky-700 underline">{{ i18n.t('web.forgot.back') }}</a>
  `,
})
export class Forgot {
  protected readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  protected readonly form = new FormState(this.i18n);
  protected readonly sentTo = signal<string | null>(null);
  protected email = '';

  protected submit(): void {
    void this.form.run(async () => {
      await firstValueFrom(this.http.post(apiUrl('/v1/auth/forgot-password'), { email: this.email }));
      this.sentTo.set(this.email.trim());
    });
  }
}
