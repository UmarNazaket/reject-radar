import { HttpClient } from '@angular/common/http';
import { Component, inject, input, type OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { InvitePreviewResponse, MeResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { FORM_IMPORTS } from './form-imports';

/**
 * The link in an invite email. Someone new chooses a name and password; someone with an account confirms with their
 * own password. Accepting signs them in to the account that invited them.
 */
@Component({
  selector: 'app-invite',
  imports: [FORM_IMPORTS],
  template: `
    @if (preview(); as invite) {
      <h1 class="mb-2 text-xl font-semibold">{{ i18n.t('web.invite.title', { orgName: invite.orgName }) }}</h1>
      <p class="mb-6 text-sm text-slate-600">
        {{ i18n.t('web.invite.body', { orgName: invite.orgName, email: invite.email, role: i18n.t('role.' + invite.role) }) }}
      </p>
      <form #f="ngForm" class="flex flex-col gap-3" (ngSubmit)="f.valid && submit()">
        @if (!invite.existingUser) {
          <mat-form-field>
            <mat-label>{{ i18n.t('web.auth.name') }}</mat-label>
            <input matInput name="name" autocomplete="name" required maxlength="100" [(ngModel)]="name" />
            <mat-error>{{ i18n.t('web.validation.required') }}</mat-error>
          </mat-form-field>
        }
        <mat-form-field>
          <mat-label>{{ invite.existingUser ? i18n.t('web.auth.password') : i18n.t('web.auth.newPassword') }}</mat-label>
          <input
            matInput
            type="password"
            name="password"
            required
            [minlength]="invite.existingUser ? 1 : 10"
            [attr.autocomplete]="invite.existingUser ? 'current-password' : 'new-password'"
            [(ngModel)]="password"
          />
          @if (!invite.existingUser) {
            <mat-hint>{{ i18n.t('web.auth.passwordHint') }}</mat-hint>
          }
          <mat-error>{{ invite.existingUser ? i18n.t('web.validation.required') : i18n.t('web.auth.passwordHint') }}</mat-error>
        </mat-form-field>
        @if (form.error(); as error) {
          <app-alert>{{ error }}</app-alert>
        }
        <button matButton="filled" type="submit" class="w-full" [disabled]="form.busy()">{{ i18n.t('web.invite.submit') }}</button>
      </form>
    } @else if (form.error(); as error) {
      <app-alert>{{ error }}</app-alert>
    } @else {
      <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class Invite implements OnInit {
  protected readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  readonly token = input.required<string>();
  protected readonly form = new FormState(this.i18n);
  protected readonly preview = signal<InvitePreviewResponse | null>(null);
  protected name = '';
  protected password = '';

  ngOnInit(): void {
    void this.form.run(async () => {
      this.preview.set(await firstValueFrom(this.http.post<InvitePreviewResponse>(apiUrl('/v1/invites/preview'), { token: this.token() })));
    });
  }

  protected submit(): void {
    const existing = this.preview()?.existingUser;
    void this.form.run(async () => {
      const body = { token: this.token(), password: this.password, ...(existing ? {} : { name: this.name, locale: this.i18n.locale() }) };
      this.session.start(await firstValueFrom(this.http.post<MeResponse>(apiUrl('/v1/invites/accept'), body)));
      await this.router.navigateByUrl('/');
    });
  }
}
