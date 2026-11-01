import type { Route } from '@angular/router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoutes } from './app.routes';
import { PRERENDERED } from './app.routes.server';

/** The first path segment of every route, looking through the empty-path shells to their children. */
function firstSegments(routes: Route[]): string[] {
  return routes.flatMap((route) => (route.path === '' ? firstSegments(route.children ?? []) : [(route.path ?? '').split('/')[0]]));
}

describe('pre-rendering and _redirects', () => {
  const rules = readFileSync(join(__dirname, '../../public/_redirects'), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));

  it('sends every browser-rendered route, and the not-found page, to the app shell', () => {
    const clientRoutes = [...new Set(firstSegments(appRoutes))].filter((segment) => segment !== '**' && !PRERENDERED.includes(segment));
    for (const segment of [...clientRoutes, 'not-found']) {
      expect(rules).toContain(`/${segment} /index.csr 200`);
      expect(rules).toContain(`/${segment}/* /index.csr 200`);
    }
    expect(rules).toHaveLength((clientRoutes.length + 1) * 2);
  });

  it('pre-renders only public routes the router has, and never rewrites them', () => {
    const routes = firstSegments(appRoutes);
    for (const page of PRERENDERED.filter(Boolean)) {
      expect(routes).toContain(page);
      expect(rules.some((rule) => rule.startsWith(`/${page} `) || rule.startsWith(`/${page}/`))).toBe(false);
    }
  });
});
