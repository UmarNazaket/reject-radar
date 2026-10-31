import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../core/i18n';

/** The links to the terms, privacy and refund pages, at the foot of the public screens. */
@Component({
  selector: 'app-legal-links',
  imports: [RouterLink],
  template: `
    <nav class="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-slate-600" [attr.aria-label]="i18n.t('web.legal.nav')">
      <a routerLink="/terms" class="underline">{{ i18n.t('web.legal.terms') }}</a>
      <a routerLink="/privacy" class="underline">{{ i18n.t('web.legal.privacy') }}</a>
      <a routerLink="/refunds" class="underline">{{ i18n.t('web.legal.refunds') }}</a>
    </nav>
  `,
})
export class LegalLinks {
  protected readonly i18n = inject(I18n);
}
