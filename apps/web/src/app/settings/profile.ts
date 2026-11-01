import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import type { MeResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { Alert } from '../layout/alert';
import { LanguageSelect } from '../layout/language-select';

/** The user's name, language and email, and the account's name for owners and admins. */
@Component({
  selector: 'app-profile',
  imports: [FormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatInputModule, Alert, LanguageSelect],
  template: `
    <div class="flex max-w-xl flex-col gap-6">
      <form #f="ngForm" class="rounded-lg border border-slate-200 bg-white p-4" (ngSubmit)="f.valid && saveName()">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.settings.you') }}</h2>
        <mat-form-field class="w-full">
          <mat-label>{{ i18n.t('web.auth.name') }}</mat-label>
          <input matInput name="name" required maxlength="100" [ngModel]="name()" (ngModelChange)="name.set($event)" />
          <mat-error>{{ i18n.t('web.validation.required') }}</mat-error>
        </mat-form-field>
        <p class="mt-2 text-sm text-slate-600">
          {{ i18n.t('web.auth.email') }}: <span dir="ltr">{{ session.user()?.email }}</span> ·
          {{ session.user()?.emailVerified ? i18n.t('web.settings.verified') : i18n.t('web.settings.notVerified') }}
        </p>
        @if (nameForm.error(); as error) {
          <app-alert class="mt-3 block">{{ error }}</app-alert>
        } @else if (saved() === 'name') {
          <app-alert kind="success" class="mt-3 block">{{ i18n.t('web.alerts.saved') }}</app-alert>
        }
        <button matButton="filled" type="submit" class="mt-3" [disabled]="nameForm.busy()">{{ i18n.t('web.alerts.save') }}</button>
      </form>

      <section class="rounded-lg border border-slate-200 bg-white p-4">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.language') }}</h2>
        <app-language-select />
        <p class="mt-3 text-sm text-slate-600">
          <a routerLink="/alerts" class="text-sky-700 underline">{{ i18n.t('web.alerts.emailTitle') }}</a>
        </p>
      </section>

      <form #o="ngForm" class="rounded-lg border border-slate-200 bg-white p-4" (ngSubmit)="o.valid && saveOrg()">
        <h2 class="mb-3 font-medium">{{ i18n.t('web.settings.organization') }}</h2>
        @if (canManage()) {
          <mat-form-field class="w-full">
            <mat-label>{{ i18n.t('web.auth.company') }}</mat-label>
            <input matInput name="org" required maxlength="200" [ngModel]="orgName()" (ngModelChange)="orgName.set($event)" />
            <mat-error>{{ i18n.t('web.validation.required') }}</mat-error>
          </mat-form-field>
          @if (orgForm.error(); as error) {
            <app-alert class="mt-3 block">{{ error }}</app-alert>
          } @else if (saved() === 'org') {
            <app-alert kind="success" class="mt-3 block">{{ i18n.t('web.alerts.saved') }}</app-alert>
          }
          <button matButton="filled" type="submit" class="mt-3" [disabled]="orgForm.busy()">{{ i18n.t('web.alerts.save') }}</button>
        } @else {
          <p>{{ session.org()?.name }}</p>
        }
        <p class="mt-3 text-sm text-slate-600">{{ i18n.t('web.settings.yourRole', { role: i18n.t('role.' + session.role()) }) }}</p>
      </form>
    </div>
  `,
})
export class Profile {
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  private readonly http = inject(HttpClient);
  protected readonly name = linkedSignal(() => this.session.user()?.name ?? '');
  protected readonly orgName = linkedSignal(() => this.session.org()?.name ?? '');
  protected readonly canManage = computed(() => this.session.role() === 'owner' || this.session.role() === 'admin');
  protected readonly nameForm = new FormState(this.i18n);
  protected readonly orgForm = new FormState(this.i18n);
  protected readonly saved = signal<'name' | 'org' | null>(null);

  protected saveName(): void {
    this.saved.set(null);
    void this.nameForm.run(async () => {
      this.session.start(await firstValueFrom(this.http.patch<MeResponse>(apiUrl('/v1/me'), { name: this.name().trim() })));
      this.saved.set('name');
    });
  }

  protected saveOrg(): void {
    this.saved.set(null);
    void this.orgForm.run(async () => {
      await firstValueFrom(this.http.patch(apiUrl('/v1/org'), { name: this.orgName().trim() }));
      await this.session.reload();
      this.saved.set('org');
    });
  }
}
