import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiUrl } from '../core/api';
import { I18n } from '../core/i18n';
import { LanguageSelect } from '../layout/language-select';
import { LegalLinks } from './legal-links';

/** The routes under `/v1/public`, as the README's "Public API" lists them. */
const ROUTES = [
  {
    path: 'GET /notices',
    what: 'Search notices, newest first, within the account’s history window. The answer’s next field is the cursor of the next page.',
    params: 'destination (US, EU, UK, AU; comma-separated), origin (ISO country code), commodity, hazard, hazardCategory, source (fda_refusal, import_alert, rasff, uk_bn, au_ifis), from and to (YYYY-MM-DD), q (3 to 100 characters of product text), cursor',
  },
  { path: 'GET /notices/:id', what: 'One notice.', params: '' },
  { path: 'GET /dashboards/topic', what: 'Monthly counts, top hazards and the latest notices for a topic.', params: 'origin (required), commodity, destination' },
  { path: 'GET /firms/search', what: 'Find firms by name or FDA FEI number, best match first.', params: 'name (2 to 200 characters) or fei, country, city' },
  { path: 'GET /firms/:id', what: 'A firm’s profile with its records. It uses one firm lookup of the plan, as in the app.', params: '' },
  { path: 'GET /import-alerts/:number', what: 'An FDA Import Alert’s text and its approved summary, for example 99-08.', params: 'locale (en, ur, hi, bn)' },
  { path: 'GET /taxonomy', what: 'The commodities, hazards, destinations and countries the other routes take, with their labels.', params: 'locale (en, ur, hi, bn)' },
  { path: 'GET /usage', what: 'This month’s API calls and the plan’s limit. It does not use a call.', params: '' },
] as const;

/** The public API reference for Business customers: in English, like the API itself. */
@Component({
  selector: 'app-developers',
  imports: [RouterLink, LanguageSelect, LegalLinks],
  template: `
    <header class="flex items-center justify-between px-4 py-3 sm:px-6">
      <a routerLink="/" class="text-lg font-semibold text-slate-900">{{ i18n.t('web.app.name') }}</a>
      <app-language-select />
    </header>
    <main class="mx-auto max-w-4xl px-4 pt-6 pb-16 sm:px-6">
      @if (i18n.locale() !== 'en') {
        <p class="mb-4 text-sm text-slate-600">{{ i18n.t('web.developers.englishOnly') }}</p>
      }
      <article lang="en" dir="ltr" class="text-start">
        <h1 class="text-2xl font-semibold">Public API</h1>
        <p class="mt-2 text-slate-700">
          Business and Enterprise accounts can read RejectRadar from their own systems. Every route is read-only and answers with the same JSON as the
          web app.
        </p>

        <h2 class="mt-8 text-lg font-semibold">Keys</h2>
        <p class="mt-2 text-slate-700">
          An owner or admin with a verified email creates keys under <a routerLink="/settings/api-keys" class="text-sky-700 underline">Settings, API keys</a>.
          A key is shown once, when it is created, so store it then. An account holds at most 5 live keys, and a key can be revoked there at any time. A key
          opens only <code>/v1/public</code>, and a signed-in session does not open it.
        </p>

        <h2 class="mt-8 text-lg font-semibold">Requests</h2>
        <p class="mt-2 text-slate-700">Send the key as a bearer token:</p>
        <pre tabindex="0" class="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm text-slate-100"><code>curl -H "Authorization: Bearer rr_live_…" \\
  "{{ base }}/v1/public/notices?origin=PK&amp;commodity=100"</code></pre>

        <h2 class="mt-8 text-lg font-semibold">Routes</h2>
        <p class="mt-2 text-slate-700">All under <code>{{ base }}/v1/public</code>.</p>
        <div class="mt-3 overflow-x-auto" tabindex="0" role="region" aria-label="Routes">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-slate-200 text-start">
                <th scope="col" class="py-2 pe-4 text-start font-medium">Route</th>
                <th scope="col" class="py-2 pe-4 text-start font-medium">What it does</th>
                <th scope="col" class="py-2 text-start font-medium">Query parameters</th>
              </tr>
            </thead>
            <tbody>
              @for (r of routes; track r.path) {
                <tr class="border-b border-slate-100 align-top">
                  <td class="py-2 pe-4 whitespace-nowrap"><code>{{ r.path }}</code></td>
                  <td class="py-2 pe-4">{{ r.what }}</td>
                  <td class="py-2 text-slate-600">{{ r.params || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <h2 class="mt-8 text-lg font-semibold">Quota and rate limit</h2>
        <ul class="mt-2 list-disc space-y-1 ps-6 text-slate-700">
          <li>Every call except <code>/usage</code> uses one of the plan’s monthly API calls: 10,000 on Business. A call with a bad query still counts.</li>
          <li>Each answer carries <code>X-Quota-Used</code> and <code>X-Quota-Limit</code>.</li>
          <li>Each key may make 60 calls a minute; past that, calls answer <code>429 RATE_LIMITED</code> with <code>Retry-After</code> in seconds.</li>
        </ul>

        <h2 class="mt-8 text-lg font-semibold">Errors</h2>
        <p class="mt-2 text-slate-700">An error answers with its HTTP status and a JSON body:</p>
        <pre
          tabindex="0"
          class="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm text-slate-100"
        ><code>{{ '{' }}
  "code": "PLAN_LIMIT_REACHED",
  "message": "…",
  "details": {{ '{' }} "action": "api_calls" {{ '}' }},
  "requestId": "…"
{{ '}' }}</code></pre>
        <ul class="mt-3 list-disc space-y-1 ps-6 text-slate-700">
          <li><code>401 API_KEY_MISSING</code>: no key, or a malformed one. <code>401 API_KEY_INVALID</code>: an unknown or revoked key.</li>
          <li><code>403 PLAN_UPGRADE_REQUIRED</code>: the plan has no API access; keys stop working after a downgrade but are kept.</li>
          <li><code>403 PLAN_LIMIT_REACHED</code>: the month’s calls are used up.</li>
          <li><code>400 BAD_REQUEST</code>: a query parameter is not valid; <code>details</code> says which.</li>
          <li><code>404 NOT_FOUND</code>: no such notice, firm or alert.</li>
          <li>Quote the <code>requestId</code> when you write to us about an error.</li>
        </ul>
      </article>
      <app-legal-links class="mt-10 block" />
    </main>
  `,
})
export class Developers {
  protected readonly i18n = inject(I18n);
  protected readonly routes = ROUTES;
  /** The API's origin: the build's own, or this site's when the API is proxied on it (development). */
  protected readonly base = apiUrl('') || location.origin;
}
