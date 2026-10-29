import { Component, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { FORM_IMPORTS } from './form-imports';
import { safeNext } from './safe-next';

@Component({
  selector: 'app-login',
  imports: [FORM_IMPORTS],
  template: `
    <h1 class="mb-6 text-xl font-semibold">{{ i18n.t('web.login.title') }}</h1>
    <form #f="ngForm" class="flex flex-col gap-3" (ngSubmit)="f.valid && submit()">
      <mat-form-field>
        <mat-label>{{ i18n.t('web.auth.email') }}</mat-label>
        <input matInput type="email" name="email" autocomplete="email" required email [(ngModel)]="email" />
        <mat-error>{{ i18n.t('web.validation.email') }}</mat-error>
      </mat-form-field>
      <mat-form-field>
        <mat-label>{{ i18n.t('web.auth.password') }}</mat-label>
        <input matInput type="password" name="password" autocomplete="current-password" required [(ngModel)]="password" />
        <mat-error>{{ i18n.t('web.validation.required') }}</mat-error>
      </mat-form-field>
      @if (form.error(); as error) {
        <app-alert>{{ error }}</app-alert>
      }
      <button matButton="filled" type="submit" class="w-full" [disabled]="form.busy()">{{ i18n.t('web.login.submit') }}</button>
    </form>
    <div class="mt-6 flex flex-col gap-2 text-sm">
      <a routerLink="/forgot" class="text-sky-700 underline">{{ i18n.t('web.login.forgot') }}</a>
      <span>{{ i18n.t('web.login.noAccount') }} <a routerLink="/signup" class="text-sky-700 underline">{{ i18n.t('web.login.signup') }}</a></span>
    </div>
  `,
})
export class Login {
  protected readonly i18n = inject(I18n);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  /** `?next=`: where the user was going when sign-in was needed. */
  readonly next = input<string>();
  protected readonly form = new FormState(this.i18n);
  protected email = '';
  protected password = '';

  protected submit(): void {
    void this.form.run(async () => {
      await this.session.login({ email: this.email, password: this.password });
      await this.router.navigateByUrl(safeNext(this.next()));
    });
  }
}
