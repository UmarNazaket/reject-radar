import { Component, inject } from '@angular/core';
import { I18n } from '../core/i18n';
import { Session } from '../core/session';

/** The signed-in start page until the topic check takes its place. */
@Component({
  selector: 'app-home',
  template: `
    <h1 class="text-2xl font-semibold">{{ i18n.t('web.home.title', { name: session.user()?.name ?? '' }) }}</h1>
    <p class="mt-2 text-slate-600">{{ i18n.t('web.home.body', { org: session.org()?.name ?? '' }) }}</p>
  `,
})
export class Home {
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
}
