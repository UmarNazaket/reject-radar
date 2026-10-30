import { Dir } from '@angular/cdk/bidi';
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/**
 * The staff admin area (P10). It is in English and left to right, whatever language the staff member reads the app in;
 * the `Dir` directive tells Material's fields and menus inside it so.
 */
@Component({
  selector: 'app-admin-layout',
  imports: [Dir, RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <div lang="en" dir="ltr" class="text-start">
      <h1 class="text-2xl font-semibold">Admin</h1>
      <nav class="mt-4 flex max-w-full gap-1 overflow-x-auto border-b border-slate-200 text-sm" aria-label="Admin">
        @for (tab of tabs; track tab.path) {
          <a
            [routerLink]="tab.path"
            routerLinkActive="border-sky-700 text-slate-900"
            [routerLinkActiveOptions]="{ exact: tab.path === '/admin' }"
            class="-mb-px border-b-2 border-transparent px-3 py-2 whitespace-nowrap text-slate-600 hover:text-slate-900"
            >{{ tab.label }}</a
          >
        }
      </nav>
      <div class="mt-6">
        <router-outlet />
      </div>
    </div>
  `,
})
export class AdminLayout {
  protected readonly tabs = [
    { path: '/admin', label: 'Source health' },
    { path: '/admin/summaries', label: 'Summaries' },
    { path: '/admin/matches', label: 'Match review' },
    { path: '/admin/firms', label: 'Firms' },
    { path: '/admin/disputes', label: 'Disputes' },
    { path: '/admin/taxonomy', label: 'Taxonomy rules' },
    { path: '/admin/accounts', label: 'Accounts' },
    { path: '/admin/audit', label: 'Audit log' },
  ];
}
