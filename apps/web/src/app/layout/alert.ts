import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../core/i18n';

const STYLES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
};

/** A message box: errors are announced at once (`role="alert"`), the others politely (`role="status"`). `upgrade` adds a link to the plans. */
@Component({
  selector: 'app-alert',
  imports: [RouterLink],
  template: `<div [attr.role]="kind() === 'error' ? 'alert' : 'status'" class="rounded-lg border px-4 py-3 text-sm" [class]="styles[kind()]">
    <ng-content />
    @if (upgrade()) {
      <a routerLink="/settings/billing" class="ms-1 font-medium underline">{{ i18n.t('web.seePlans') }}</a>
    }
  </div>`,
})
export class Alert {
  protected readonly i18n = inject(I18n);
  readonly kind = input<keyof typeof STYLES>('error');
  readonly upgrade = input(false);
  protected readonly styles = STYLES;
}
