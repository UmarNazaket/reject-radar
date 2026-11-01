import { RenderMode, type ServerRoute } from '@angular/ssr';

/** The public pages, built as HTML at build time. Any other route renders in the browser from `index.csr.html` (public/_redirects). */
export const PRERENDERED = ['', 'pricing', 'sources', 'developers', 'disclaimer', 'terms', 'privacy', 'refunds'];

export const serverRoutes: ServerRoute[] = [
  ...PRERENDERED.map((path): ServerRoute => ({ path, renderMode: RenderMode.Prerender })),
  { path: '**', renderMode: RenderMode.Client },
];
