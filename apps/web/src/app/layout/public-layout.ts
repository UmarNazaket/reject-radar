import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { I18n } from '../core/i18n';
import { LanguageSelect } from './language-select';

/** Sign-in screens: the brand, the language switch and one card. */
@Component({
  selector: 'app-public-layout',
  imports: [RouterOutlet, RouterLink, LanguageSelect],
  template: `
    <header class="flex items-center justify-between px-4 py-3 sm:px-6">
      <a routerLink="/" class="text-lg font-semibold text-slate-900">{{ i18n.t('web.app.name') }}</a>
      <app-language-select />
    </header>
    <main class="mx-auto w-full max-w-md px-4 pb-16 pt-6">
      <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <router-outlet />
      </div>
    </main>
  `,
})
export class PublicLayout {
  protected readonly i18n = inject(I18n);
}
