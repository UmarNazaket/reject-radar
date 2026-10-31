import { inject } from '@angular/core';
import { type Route, Router } from '@angular/router';
import { signedIn, signedOut, staffOnly } from './core/guards';

// The signed-in shell comes first: an empty-path parent also matches the empty URL when none of its children do, so
// listing the sign-in screens first would show their layout, empty, at `/`.
export const appRoutes: Route[] = [
  // Public, for anyone signed in or not, with its own header.
  { path: 'pricing', loadComponent: () => import('./pricing/pricing').then((m) => m.Pricing) },
  { path: 'terms', data: { page: 'terms' }, loadComponent: () => import('./legal/legal').then((m) => m.Legal) },
  { path: 'privacy', data: { page: 'privacy' }, loadComponent: () => import('./legal/legal').then((m) => m.Legal) },
  { path: 'refunds', data: { page: 'refunds' }, loadComponent: () => import('./legal/legal').then((m) => m.Legal) },
  // Checkout returns and payment-failed emails sent before P9 link here.
  {
    path: 'app/settings/billing',
    redirectTo: ({ queryParams }) => inject(Router).createUrlTree(['/settings/billing'], { queryParams }),
  },
  {
    path: '',
    canActivate: [signedIn],
    loadComponent: () => import('./layout/app-layout').then((m) => m.AppLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'topics' },
      { path: 'topics', loadComponent: () => import('./topics/topic-check').then((m) => m.TopicCheck) },
      { path: 'notices', loadComponent: () => import('./notices/notice-search').then((m) => m.NoticeSearch) },
      { path: 'notices/:id', loadComponent: () => import('./notices/notice-detail').then((m) => m.NoticeDetail) },
      { path: 'firms', loadComponent: () => import('./firms/firm-search').then((m) => m.FirmSearch) },
      { path: 'firms/:id', loadComponent: () => import('./firms/firm-profile').then((m) => m.FirmProfile) },
      { path: 'mrl', loadComponent: () => import('./mrl/mrl-check').then((m) => m.MrlCheck) },
      { path: 'watchlist', loadComponent: () => import('./watchlist/watchlist').then((m) => m.Watchlist) },
      { path: 'alerts', loadComponent: () => import('./alerts/alert-list').then((m) => m.AlertList) },
      { path: 'bulk', loadComponent: () => import('./bulk/bulk-jobs').then((m) => m.BulkJobs) },
      { path: 'bulk/:id', loadComponent: () => import('./bulk/bulk-job').then((m) => m.BulkJob) },
      {
        path: 'settings',
        loadComponent: () => import('./settings/settings-layout').then((m) => m.SettingsLayout),
        children: [
          { path: '', pathMatch: 'full', loadComponent: () => import('./settings/profile').then((m) => m.Profile) },
          { path: 'team', loadComponent: () => import('./settings/team').then((m) => m.Team) },
          { path: 'billing', loadComponent: () => import('./settings/billing').then((m) => m.Billing) },
          { path: 'api-keys', loadComponent: () => import('./settings/api-keys').then((m) => m.ApiKeys) },
        ],
      },
      {
        path: 'admin',
        canActivate: [staffOnly],
        loadComponent: () => import('./admin/admin-layout').then((m) => m.AdminLayout),
        children: [
          { path: '', pathMatch: 'full', loadComponent: () => import('./admin/source-health').then((m) => m.SourceHealth) },
          { path: 'summaries', loadComponent: () => import('./admin/summaries').then((m) => m.AdminSummaries) },
          { path: 'matches', loadComponent: () => import('./admin/match-reviews').then((m) => m.AdminMatchReviews) },
          { path: 'firms', loadComponent: () => import('./admin/admin-firm').then((m) => m.AdminFirm) },
          { path: 'firms/:id', loadComponent: () => import('./admin/admin-firm').then((m) => m.AdminFirm) },
          { path: 'disputes', loadComponent: () => import('./admin/disputes').then((m) => m.AdminDisputes) },
          { path: 'taxonomy', loadComponent: () => import('./admin/taxonomy-rules').then((m) => m.AdminTaxonomyRules) },
          { path: 'accounts', loadComponent: () => import('./admin/accounts').then((m) => m.AdminAccounts) },
          { path: 'accounts/:id', loadComponent: () => import('./admin/account').then((m) => m.AdminAccount) },
          { path: 'audit', loadComponent: () => import('./admin/audit-log').then((m) => m.AdminAuditLog) },
        ],
      },
      { path: 'import-alerts/:number', loadComponent: () => import('./import-alerts/import-alert').then((m) => m.ImportAlert) },
    ],
  },
  {
    path: '',
    loadComponent: () => import('./layout/public-layout').then((m) => m.PublicLayout),
    children: [
      { path: 'login', canActivate: [signedOut], loadComponent: () => import('./auth/login').then((m) => m.Login) },
      { path: 'signup', canActivate: [signedOut], loadComponent: () => import('./auth/signup').then((m) => m.Signup) },
      { path: 'forgot', canActivate: [signedOut], loadComponent: () => import('./auth/forgot').then((m) => m.Forgot) },
      // These come from emails and work whether or not someone is signed in on this browser.
      { path: 'verify', loadComponent: () => import('./auth/verify').then((m) => m.Verify) },
      { path: 'reset', loadComponent: () => import('./auth/reset').then((m) => m.Reset) },
      { path: 'invite/:token', loadComponent: () => import('./auth/invite').then((m) => m.Invite) },
    ],
  },
  { path: '**', loadComponent: () => import('./layout/not-found').then((m) => m.NotFound) },
];
