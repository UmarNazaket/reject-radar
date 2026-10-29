import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { I18n } from '../core/i18n';

/** Settings: one tab per area, each its own route. */
@Component({
  selector: 'app-settings-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <h1 class="text-2xl font-semibold">{{ i18n.t('web.settings.title') }}</h1>
    <nav class="mt-4 flex max-w-full gap-1 overflow-x-auto border-b border-slate-200 text-sm" [attr.aria-label]="i18n.t('web.settings.title')">
      @for (tab of tabs; track tab.path) {
        <a
          [routerLink]="tab.path"
          routerLinkActive="border-sky-700 text-slate-900"
          [routerLinkActiveOptions]="{ exact: true }"
          class="-mb-px border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-slate-600 hover:text-slate-900"
          >{{ i18n.t(tab.label) }}</a
        >
      }
    </nav>
    <div class="mt-6">
      <router-outlet />
    </div>
  `,
})
export class SettingsLayout {
  protected readonly i18n = inject(I18n);
  protected readonly tabs = [
    { path: '/settings', label: 'web.settings.profile' },
    { path: '/settings/team', label: 'web.settings.team' },
    { path: '/settings/billing', label: 'web.settings.billing' },
    { path: '/settings/api-keys', label: 'web.settings.apiKeys' },
  ];
}
