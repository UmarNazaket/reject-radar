import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import type { SignupRequest } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { FORM_IMPORTS } from './form-imports';

@Component({
  selector: 'app-signup',
  imports: [FORM_IMPORTS],
  template: `
    @if (sentTo(); as email) {
      <h1 class="mb-4 text-xl font-semibold">{{ i18n.t('web.signup.sentTitle') }}</h1>
      <p class="text-slate-700">{{ i18n.t('web.signup.sentBody', { email }) }}</p>
    } @else {
      <h1 class="mb-6 text-xl font-semibold">{{ i18n.t('web.signup.title') }}</h1>
      <form #f="ngForm" class="flex flex-col gap-3" (ngSubmit)="f.valid && submit()">
        <mat-form-field>
          <mat-label>{{ i18n.t('web.auth.name') }}</mat-label>
          <input matInput name="name" autocomplete="name" required maxlength="100" [(ngModel)]="body.name" />
          <mat-error>{{ i18n.t('web.validation.required') }}</mat-error>
        </mat-form-field>
        <mat-form-field>
          <mat-label>{{ i18n.t('web.auth.company') }}</mat-label>
          <input matInput name="companyName" autocomplete="organization" required maxlength="120" [(ngModel)]="body.companyName" />
          <mat-error>{{ i18n.t('web.validation.required') }}</mat-error>
        </mat-form-field>
        <mat-form-field>
          <mat-label>{{ i18n.t('web.auth.email') }}</mat-label>
          <input matInput type="email" name="email" autocomplete="email" required email [(ngModel)]="body.email" />
          <mat-error>{{ i18n.t('web.validation.email') }}</mat-error>
        </mat-form-field>
        <mat-form-field>
          <mat-label>{{ i18n.t('web.auth.password') }}</mat-label>
          <input matInput type="password" name="password" autocomplete="new-password" required minlength="10" [(ngModel)]="body.password" />
          <mat-hint>{{ i18n.t('web.auth.passwordHint') }}</mat-hint>
          <mat-error>{{ i18n.t('web.auth.passwordHint') }}</mat-error>
        </mat-form-field>
        @if (form.error(); as error) {
          <app-alert>{{ error }}</app-alert>
        }
        <button matButton="filled" type="submit" class="w-full" [disabled]="form.busy()">{{ i18n.t('web.signup.submit') }}</button>
      </form>
      <p class="mt-6 text-sm">{{ i18n.t('web.signup.haveAccount') }} <a routerLink="/login" class="text-sky-700 underline">{{ i18n.t('web.signup.login') }}</a></p>
    }
  `,
})
export class Signup {
  protected readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  protected readonly form = new FormState(this.i18n);
  protected readonly sentTo = signal<string | null>(null);
  protected readonly body: Omit<SignupRequest, 'locale'> = { name: '', companyName: '', email: '', password: '' };

  protected submit(): void {
    void this.form.run(async () => {
      // The account's language is the one the person signed up in; emails follow it.
      await firstValueFrom(this.http.post(apiUrl('/v1/auth/signup'), { ...this.body, locale: this.i18n.locale() }));
      this.sentTo.set(this.body.email.trim());
    });
  }
}
