import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { I18n } from '../core/i18n';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <main class="mx-auto max-w-md px-4 py-24 text-center">
      <h1 class="text-2xl font-semibold">{{ i18n.t('web.notFound.title') }}</h1>
      <a routerLink="/" class="mt-6 inline-block text-sky-700 underline">{{ i18n.t('web.notFound.home') }}</a>
    </main>
  `,
})
export class NotFound {
  protected readonly i18n = inject(I18n);
}
