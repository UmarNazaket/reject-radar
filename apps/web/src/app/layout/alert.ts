import { Component, input } from '@angular/core';

const STYLES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
};

/** A message box: errors are announced at once (`role="alert"`), the others politely (`role="status"`). */
@Component({
  selector: 'app-alert',
  template: `<div [attr.role]="kind() === 'error' ? 'alert' : 'status'" class="rounded-lg border px-4 py-3 text-sm" [class]="styles[kind()]"><ng-content /></div>`,
})
export class Alert {
  readonly kind = input<keyof typeof STYLES>('error');
  protected readonly styles = STYLES;
}
