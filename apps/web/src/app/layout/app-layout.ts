import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { Alert } from './alert';
import { LanguageSelect } from './language-select';

/** The signed-in shell: top bar, navigation, and a reminder to verify the email address until it is verified. */
@Component({
  selector: 'app-app-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule, Alert, LanguageSelect],
  template: `
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <a routerLink="/" class="text-lg font-semibold text-slate-900">{{ i18n.t('web.app.name') }}</a>
        <nav class="flex gap-1" [attr.aria-label]="i18n.t('web.nav.label')">
          <a routerLink="/topics" routerLinkActive="bg-slate-100" class="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            {{ i18n.t('web.nav.topics') }}
          </a>
          <a routerLink="/notices" routerLinkActive="bg-slate-100" class="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            {{ i18n.t('web.nav.notices') }}
          </a>
          <a routerLink="/firms" routerLinkActive="bg-slate-100" class="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            {{ i18n.t('web.nav.firms') }}
          </a>
          <a routerLink="/mrl" routerLinkActive="bg-slate-100" class="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            {{ i18n.t('web.nav.mrl') }}
          </a>
        </nav>
        <div class="ms-auto flex items-center gap-3">
          <app-language-select />
          <span class="hidden text-sm text-slate-600 sm:inline">{{ session.user()?.name }}</span>
          <button matButton type="button" (click)="signOut()">{{ i18n.t('web.nav.signOut') }}</button>
        </div>
      </div>
    </header>
    @if (session.user(); as user) {
      @if (!user.emailVerified) {
        <div class="mx-auto flex max-w-6xl flex-col gap-2 px-4 pt-4 sm:px-6">
          <app-alert kind="warn">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>{{ sent() ? i18n.t('web.verifyBanner.sent', { email: user.email }) : i18n.t('web.verifyBanner.body') }}</span>
              @if (!sent()) {
                <button type="button" class="font-medium underline" [disabled]="form.busy()" (click)="resend(user.email)">{{ i18n.t('web.verifyBanner.resend') }}</button>
              }
            </div>
          </app-alert>
          @if (form.error(); as error) {
            <app-alert>{{ error }}</app-alert>
          }
        </div>
      }
    }
    <main class="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <router-outlet />
    </main>
  `,
})
export class AppLayout {
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly form = new FormState(this.i18n);
  protected readonly sent = signal(false);

  protected resend(email: string): void {
    void this.form.run(async () => {
      await firstValueFrom(this.http.post(apiUrl('/v1/auth/resend-verification'), { email }));
      this.sent.set(true);
    });
  }

  protected async signOut(): Promise<void> {
    await this.session.logout();
    await this.router.navigate(['/login']);
  }
}
