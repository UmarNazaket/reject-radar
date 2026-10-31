import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import type { MembersResponse } from '@rejectradar/contracts';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../core/api';
import { errorMessage } from '../core/errors';
import { FormState } from '../core/form-state';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';
import { Alert } from '../layout/alert';

const ROLES = ['owner', 'admin', 'member'];
const INVITE_ROLES = ['admin', 'member'];

/** The account's members and open invites; owners and admins change roles, remove people and invite. */
@Component({
  selector: 'app-team',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, Alert],
  template: `
    @if (action.error(); as error) {
      <app-alert class="mb-4 block" [upgrade]="action.upgrade()">{{ error }}</app-alert>
    }
    @if (team.error(); as error) {
      <app-alert>{{ errorText(error) }}</app-alert>
    } @else if (team.hasValue()) {
      <section class="rounded-lg border border-slate-200 bg-white">
        <h2 class="border-b border-slate-100 p-4 font-medium">{{ i18n.t('web.team.members') }}</h2>
        <ul class="divide-y divide-slate-100">
          @for (m of team.value().members; track m.userId) {
            <li class="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
              <div class="min-w-0 flex-1">
                <p class="font-medium" dir="auto">{{ m.name }}</p>
                <p class="text-slate-600" dir="ltr">{{ m.email }}</p>
              </div>
              @if (canManage() && m.userId !== me()) {
                <mat-select class="w-40" [value]="m.role" [aria-label]="i18n.t('web.team.role')" (selectionChange)="changeRole(m.userId, $event.value)">
                  @for (r of roles; track r) {
                    <mat-option [value]="r">{{ i18n.t('role.' + r) }}</mat-option>
                  }
                </mat-select>
                <button matButton type="button" [disabled]="action.busy()" (click)="remove(m.userId, false)">{{ i18n.t('web.watchlist.remove') }}</button>
              } @else {
                <span>{{ i18n.t('role.' + m.role) }}</span>
                @if (m.userId === me()) {
                  <button matButton type="button" [disabled]="action.busy()" (click)="remove(m.userId, true)">{{ i18n.t('web.team.leave') }}</button>
                }
              }
            </li>
          }
        </ul>
      </section>

      @if (canManage()) {
        <section class="mt-6 rounded-lg border border-slate-200 bg-white">
          <h2 class="border-b border-slate-100 p-4 font-medium">{{ i18n.t('web.team.invites') }}</h2>
          <ul class="divide-y divide-slate-100">
            @for (i of team.value().invites; track i.id) {
              <li class="flex flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
                <span class="min-w-0 flex-1" dir="ltr">{{ i.email }}</span>
                <span>{{ i18n.t('role.' + i.role) }}</span>
                <span class="text-slate-600">{{ i18n.t('web.team.expires', { date: i18n.date(i.expiresAt) }) }}</span>
                <button matButton type="button" [disabled]="action.busy()" (click)="revoke(i.id)">{{ i18n.t('web.team.revoke') }}</button>
              </li>
            } @empty {
              <li class="p-4 text-sm text-slate-600">{{ i18n.t('web.team.noInvites') }}</li>
            }
          </ul>
          <form #f="ngForm" class="flex flex-wrap items-start gap-3 border-t border-slate-100 p-4" (ngSubmit)="f.valid && invite(f)">
            <mat-form-field class="min-w-64 flex-1">
              <mat-label>{{ i18n.t('web.auth.email') }}</mat-label>
              <input matInput name="email" type="email" required email [(ngModel)]="inviteEmail" />
              <mat-error>{{ i18n.t('web.validation.email') }}</mat-error>
            </mat-form-field>
            <mat-form-field class="w-40">
              <mat-label>{{ i18n.t('web.team.role') }}</mat-label>
              <mat-select name="role" [(ngModel)]="inviteRole">
                @for (r of inviteRoles; track r) {
                  <mat-option [value]="r">{{ i18n.t('role.' + r) }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <button matButton="filled" type="submit" class="mt-2" [disabled]="action.busy()">{{ i18n.t('web.team.invite') }}</button>
          </form>
          @if (invited(); as email) {
            <app-alert kind="success" class="m-4 block">{{ i18n.t('web.team.invited', { email }) }}</app-alert>
          }
        </section>
      }
    } @else {
      <p class="text-slate-600">{{ i18n.t('web.loading') }}</p>
    }
  `,
})
export class Team {
  protected readonly i18n = inject(I18n);
  private readonly session = inject(Session);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly roles = ROLES;
  protected readonly inviteRoles = INVITE_ROLES;
  protected readonly team = httpResource<MembersResponse>(() => apiUrl('/v1/org/members'));
  protected readonly me = computed(() => this.session.user()?.id);
  protected readonly canManage = computed(() => this.session.role() === 'owner' || this.session.role() === 'admin');
  protected readonly action = new FormState(this.i18n);
  protected readonly invited = signal<string | null>(null);
  protected inviteEmail = '';
  protected inviteRole = 'member';

  protected errorText(error: unknown): string {
    return errorMessage(this.i18n, error);
  }

  protected changeRole(userId: string, role: string): void {
    // On a refusal (the last owner, for example) the list reloads, so the select shows the role that stands.
    void this.action.run(async () => {
      try {
        await firstValueFrom(this.http.patch(apiUrl(`/v1/org/members/${userId}`), { role }));
      } finally {
        this.team.reload();
      }
    });
  }

  protected remove(userId: string, self: boolean): void {
    if (!confirm(this.i18n.t(self ? 'web.team.leaveConfirm' : 'web.team.removeConfirm'))) return;
    void this.action.run(async () => {
      await firstValueFrom(this.http.delete(apiUrl(`/v1/org/members/${userId}`)));
      if (self) {
        // Leaving ends the membership this session belongs to.
        await this.session.logout();
        await this.router.navigate(['/login']);
      } else {
        this.team.reload();
      }
    });
  }

  protected revoke(id: string): void {
    void this.action.run(async () => {
      await firstValueFrom(this.http.delete(apiUrl(`/v1/org/invites/${id}`)));
      this.team.reload();
    });
  }

  protected invite(form: { resetForm: (value?: unknown) => void }): void {
    this.invited.set(null);
    const email = this.inviteEmail.trim();
    void this.action.run(async () => {
      await firstValueFrom(this.http.post(apiUrl('/v1/org/invites'), { email, role: this.inviteRole }));
      this.invited.set(email);
      form.resetForm({ email: '', role: 'member' });
      this.team.reload();
    });
  }
}
