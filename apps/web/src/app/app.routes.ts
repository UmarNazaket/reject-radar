import type { Route } from '@angular/router';
import { signedIn, signedOut } from './core/guards';

// The signed-in shell comes first: an empty-path parent also matches the empty URL when none of its children do, so
// listing the sign-in screens first would show their layout, empty, at `/`.
export const appRoutes: Route[] = [
  {
    path: '',
    canActivate: [signedIn],
    loadComponent: () => import('./layout/app-layout').then((m) => m.AppLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'topics' },
      { path: 'topics', loadComponent: () => import('./topics/topic-check').then((m) => m.TopicCheck) },
      { path: 'notices', loadComponent: () => import('./notices/notice-search').then((m) => m.NoticeSearch) },
      { path: 'notices/:id', loadComponent: () => import('./notices/notice-detail').then((m) => m.NoticeDetail) },
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
