import { HttpClient } from '@angular/common/http';
import { Component, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { FORM_IMPORTS } from './form-imports';

/** The link in the password-reset email. Resetting ends every session, so the user signs in again. */
@Component({
  selector: 'app-reset',
  imports: [FORM_IMPORTS],
  template: `
    <h1 class="mb-6 text-xl font-semibold">{{ i18n.t('web.reset.title') }}</h1>
    @if (done()) {
      <app-alert kind="success">{{ i18n.t('web.reset.done') }}</app-alert>
      <a routerLink="/login" class="mt-6 inline-block text-sky-700 underline">{{ i18n.t('web.signup.login') }}</a>
    } @else {
      <form #f="ngForm" class="flex flex-col gap-3" (ngSubmit)="f.valid && submit()">
        <mat-form-field>
          <mat-label>{{ i18n.t('web.auth.newPassword') }}</mat-label>
          <input matInput type="password" name="password" autocomplete="new-password" required minlength="10" [(ngModel)]="password" />
          <mat-hint>{{ i18n.t('web.auth.passwordHint') }}</mat-hint>
          <mat-error>{{ i18n.t('web.auth.passwordHint') }}</mat-error>
        </mat-form-field>
        @if (form.error(); as error) {
          <app-alert>{{ error }}</app-alert>
        }
        <button matButton="filled" type="submit" class="w-full" [disabled]="form.busy()">{{ i18n.t('web.reset.submit') }}</button>
      </form>
    }
  `,
})
export class Reset {
  protected readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly session = inject(Session);
  readonly token = input<string>();
  protected readonly form = new FormState(this.i18n);
  protected readonly done = signal(false);
  protected password = '';

  protected submit(): void {
    void this.form.run(async () => {
      await firstValueFrom(this.http.post(apiUrl('/v1/auth/reset-password'), { token: this.token() ?? '', password: this.password }));
      this.session.clear();
      this.done.set(true);
    });
  }
}
