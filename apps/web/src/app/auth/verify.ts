import { HttpClient } from '@angular/common/http';
import { Component, inject, input, type OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { Alert } from '../layout/alert';

/** The link in the verification email: confirms the address as soon as it opens. */
@Component({
  selector: 'app-verify',
  imports: [RouterLink, Alert],
  template: `
    <h1 class="mb-4 text-xl font-semibold">{{ i18n.t('web.verify.title') }}</h1>
    @if (done()) {
      <app-alert kind="success">{{ i18n.t('web.verify.done') }}</app-alert>
      <a routerLink="/" class="mt-6 inline-block text-sky-700 underline">{{ i18n.t('web.verify.continue') }}</a>
    } @else if (form.error(); as error) {
      <app-alert>{{ error }}</app-alert>
      <a routerLink="/login" class="mt-6 inline-block text-sky-700 underline">{{ i18n.t('web.forgot.back') }}</a>
    } @else {
      <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class Verify implements OnInit {
  protected readonly i18n = inject(I18n);
  private readonly http = inject(HttpClient);
  private readonly session = inject(Session);
  readonly token = input<string>();
  protected readonly form = new FormState(this.i18n);
  protected readonly done = signal(false);

  ngOnInit(): void {
    void this.form.run(async () => {
      await firstValueFrom(this.http.post(apiUrl('/v1/auth/verify-email'), { token: this.token() ?? '' }));
      // Signed in on this browser: the banner asking to verify goes away.
      if (this.session.signedIn()) await this.session.reload();
      this.done.set(true);
    });
  }
}
