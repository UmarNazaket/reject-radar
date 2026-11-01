/**
 * Every route of the API is either account-owned (listed in `ACCOUNT_ROUTES`, and proven by `isolation.e2e.spec.ts`
 * to be out of reach of other accounts) or documented as not account-owned (`NOT_ACCOUNT_OWNED`, with the reason).
 * A route in neither list fails the "every route is registered" spec, so a phase that adds a route has to decide.
 */

/** The two accounts the harness builds: an owner, one member and one pending invite each. */
export interface AccountFixture {
  orgId: string;
  ownerId: string;
  memberId: string;
  inviteId: string;
  /** The id of the firm item on the account's watchlist, its label and the name of its firm. */
  watchlistItemId: string;
  watchlistLabel: string;
  watchlistFirmName: string;
  /** The id of the alert on the account's inbox, raised by an event about the watched firm. */
  alertId: string;
  /** The account's Paddle customer and subscription ids, which no other account may ever see. */
  paddleIds: string[];
  /** The owner's, the member's and the pending invite's email addresses. */
  emails: string[];
  /** The id and file name of the account's bulk job, uploaded by its owner. */
  bulkJobId: string;
  bulkFileName: string;
  /** The id of the job's only row, which account A's review of it must not change. */
  bulkRowId: string;
  /** The id, name and display prefix of the account's API key. */
  apiKeyId: string;
  apiKeyName: string;
  apiKeyPrefix: string;
}

export interface IsolationCase {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** The route as Express lists it, with `:params`, for example `/v1/org/members/:userId`. */
  path: string;
  /** A valid request body for the route, built from account B's fixture when it needs one. A string body is sent as it is. */
  body?: (b: AccountFixture) => unknown;
  /** The `Content-Type` of the body when it is not JSON (the bulk upload sends `text/csv`). */
  contentType?: string;
  /** Query parameters the route needs to answer 200. */
  query?: Record<string, string>;
  /** Fills the `:params` of `path` with account B's ids; the harness then expects 404 and B unchanged. */
  target?: (b: AccountFixture) => Record<string, string>;
}

/** The fresh address the harness invites from A: it belongs to neither account, so it can never be mistaken for B's. */
const FRESH_INVITEE = 'fresh.invitee@isolation.test';

export const ACCOUNT_ROUTES: IsolationCase[] = [
  { method: 'GET', path: '/v1/me' },
  { method: 'PATCH', path: '/v1/me', body: () => ({ name: 'Renamed By A' }) },
  { method: 'GET', path: '/v1/org' },
  { method: 'PATCH', path: '/v1/org', body: () => ({ name: 'Renamed Company A' }) },
  { method: 'GET', path: '/v1/org/members' },
  {
    method: 'PATCH',
    path: '/v1/org/members/:userId',
    body: () => ({ role: 'admin' }),
    target: (b) => ({ userId: b.memberId }),
  },
  { method: 'DELETE', path: '/v1/org/members/:userId', target: (b) => ({ userId: b.memberId }) },
  { method: 'POST', path: '/v1/org/invites', body: () => ({ email: FRESH_INVITEE, role: 'member' }) },
  { method: 'DELETE', path: '/v1/org/invites/:id', target: (b) => ({ id: b.inviteId }) },
  { method: 'GET', path: '/v1/watchlist' },
  { method: 'POST', path: '/v1/watchlist', body: () => ({ kind: 'topic', originCountry: 'VN' }) },
  { method: 'GET', path: '/v1/watchlist/export.csv' },
  { method: 'GET', path: '/v1/watchlist/topic-estimate', query: { originCountry: 'VN' } },
  { method: 'PATCH', path: '/v1/watchlist/:id', body: () => ({ label: 'x' }), target: (b) => ({ id: b.watchlistItemId }) },
  { method: 'DELETE', path: '/v1/watchlist/:id', target: (b) => ({ id: b.watchlistItemId }) },
  { method: 'GET', path: '/v1/alerts' },
  { method: 'GET', path: '/v1/alerts/:id', target: (b) => ({ id: b.alertId }) },
  { method: 'POST', path: '/v1/alerts/read', body: (b) => ({ ids: [b.alertId] }) },
  { method: 'GET', path: '/v1/me/notification-prefs' },
  { method: 'PUT', path: '/v1/me/notification-prefs', body: () => ({ instantHigh: false, digest: 'weekly' }) },
  { method: 'GET', path: '/v1/billing/subscription' },
  { method: 'POST', path: '/v1/billing/checkout', body: () => ({ plan: 'pro', interval: 'month' }) },
  { method: 'POST', path: '/v1/billing/portal' },
  {
    method: 'POST',
    path: '/v1/bulk-jobs',
    body: () => 'name,country,city,fei\r\nIsolation Uploader Ltd,PK,Karachi,\r\n',
    contentType: 'text/csv',
    query: { fileName: 'isolation-upload.csv' },
  },
  { method: 'GET', path: '/v1/bulk-jobs' },
  { method: 'GET', path: '/v1/bulk-jobs/:id', target: (b) => ({ id: b.bulkJobId }) },
  { method: 'GET', path: '/v1/bulk-jobs/:id/rows', target: (b) => ({ id: b.bulkJobId }) },
  {
    method: 'PATCH',
    path: '/v1/bulk-jobs/:id/rows/:rowId',
    body: () => ({ action: 'reject' }),
    target: (b) => ({ id: b.bulkJobId, rowId: b.bulkRowId }),
  },
  { method: 'POST', path: '/v1/bulk-jobs/:id/watch-confirmed', target: (b) => ({ id: b.bulkJobId }) },
  { method: 'GET', path: '/v1/bulk-jobs/:id/export.csv', target: (b) => ({ id: b.bulkJobId }) },
  { method: 'GET', path: '/v1/org/api-keys' },
  { method: 'POST', path: '/v1/org/api-keys', body: () => ({ name: 'Key made by A' }) },
  { method: 'DELETE', path: '/v1/org/api-keys/:id', target: (b) => ({ id: b.apiKeyId }) },
  // The notices behind the topic report are reference data; the report is the caller's, since it names the caller's own account.
  { method: 'GET', path: '/v1/dashboards/topic/report.pdf', query: { origin: 'PK' } },
];

export const NOT_ACCOUNT_OWNED: { method: string; path: string; reason: string }[] = [
  ...[
    'signup',
    'verify-email',
    'resend-verification',
    'login',
    'refresh',
    'logout',
    'forgot-password',
    'reset-password',
  ].map((name) => ({
    method: 'POST',
    path: `/v1/auth/${name}`,
    reason: 'Authentication acts on the person named by the email, token or cookie it carries, and holds no account data.',
  })),
  { method: 'GET', path: '/v1/dev/emails', reason: 'Dev-only email preview; never mounted in production.' },
  {
    method: 'GET',
    path: '/v1/dev/emails/:template/:locale',
    reason: 'Dev-only email preview; never mounted in production.',
  },
  { method: 'GET', path: '/v1/health', reason: 'Liveness probe; reads no data.' },
  { method: 'GET', path: '/v1/health/ready', reason: 'Readiness probe; checks the database connection and reads no account data.' },
  {
    method: 'GET',
    path: '/v1/notices',
    reason: "Reference data; the plan's history window is the only account-dependent part.",
  },
  {
    method: 'GET',
    path: '/v1/notices/:id',
    reason: "Reference data; the plan's history window is the only account-dependent part.",
  },
  {
    method: 'GET',
    path: '/v1/dashboards/topic',
    reason: "Reference data; the plan's history window is the only account-dependent part.",
  },
  { method: 'GET', path: '/v1/billing/plans', reason: 'Public price list; no account data.' },
  { method: 'GET', path: '/v1/bulk-jobs/template.csv', reason: 'The same template for every caller; no account data' },
  { method: 'POST', path: '/v1/webhooks/paddle', reason: 'Paddle calls it; the verified payload names the account.' },
  { method: 'GET', path: '/v1/taxonomy', reason: 'Reference data; the same for every caller.' },
  { method: 'GET', path: '/v1/firms/search', reason: 'Reference data; no account data in the results.' },
  { method: 'GET', path: '/v1/firms/:id', reason: "Reference data; the lookup is charged to the caller's own account." },
  {
    method: 'GET',
    path: '/v1/firms/:id/report.pdf',
    reason:
      "Reference data; the lookup is charged to, and the account name printed from, the caller's own context, which firm-report.e2e.spec.ts proves.",
  },
  { method: 'POST', path: '/v1/firms/:id/disputes', reason: "Writes only to the caller's account; there is no read." },
  { method: 'GET', path: '/v1/import-alerts/:number', reason: 'Reference data.' },
  { method: 'GET', path: '/v1/admin/import-alert-summaries', reason: 'Platform admins only; Import Alert summaries are reference data.' },
  { method: 'PATCH', path: '/v1/admin/import-alert-summaries/:number', reason: 'Platform admins only; Import Alert summaries are reference data.' },
  { method: 'GET', path: '/v1/admin/sources', reason: 'Platform admins only; sync runs are not owned by an account.' },
  { method: 'GET', path: '/v1/admin/match-reviews', reason: 'Platform admins only; firms are reference data.' },
  { method: 'POST', path: '/v1/admin/match-reviews/:id/decision', reason: 'Platform admins only; firms are reference data.' },
  { method: 'GET', path: '/v1/admin/firms/:id', reason: 'Platform admins only; firms are reference data.' },
  { method: 'POST', path: '/v1/admin/firms/merge', reason: 'Platform admins only; firms are reference data.' },
  { method: 'POST', path: '/v1/admin/firms/:id/split', reason: 'Platform admins only; firms are reference data.' },
  { method: 'GET', path: '/v1/admin/disputes', reason: 'Platform admins only; staff review every account\'s disputes.' },
  { method: 'PATCH', path: '/v1/admin/disputes/:id', reason: 'Platform admins only; staff review every account\'s disputes.' },
  { method: 'GET', path: '/v1/admin/taxonomy-rules', reason: 'Platform admins only; the taxonomy rules are reference data.' },
  { method: 'POST', path: '/v1/admin/taxonomy-rules', reason: 'Platform admins only; the taxonomy rules are reference data.' },
  { method: 'POST', path: '/v1/admin/taxonomy-rules/preview', reason: 'Platform admins only; the taxonomy rules are reference data.' },
  { method: 'PATCH', path: '/v1/admin/taxonomy-rules/:kind/:id', reason: 'Platform admins only; the taxonomy rules are reference data.' },
  { method: 'DELETE', path: '/v1/admin/taxonomy-rules/:kind/:id', reason: 'Platform admins only; the taxonomy rules are reference data.' },
  { method: 'GET', path: '/v1/admin/taxonomy/remap', reason: 'Platform admins only; the taxonomy rules are reference data.' },
  { method: 'POST', path: '/v1/admin/taxonomy/remap', reason: 'Platform admins only; the taxonomy rules are reference data.' },
  { method: 'GET', path: '/v1/admin/orgs', reason: 'Platform admins only; staff look across every account.' },
  { method: 'GET', path: '/v1/admin/orgs/:id', reason: 'Platform admins only; staff look across every account.' },
  { method: 'PATCH', path: '/v1/admin/orgs/:id', reason: 'Platform admins only; staff look across every account.' },
  { method: 'POST', path: '/v1/admin/orgs/:id/deactivate', reason: 'Platform admins only; staff look across every account.' },
  { method: 'POST', path: '/v1/admin/orgs/:id/reactivate', reason: 'Platform admins only; staff look across every account.' },
  { method: 'GET', path: '/v1/admin/taxonomy/unmapped', reason: 'Platform admins only; reference data, no account.' },
  { method: 'GET', path: '/v1/admin/users', reason: 'Platform admins only; staff look across every account.' },
  { method: 'GET', path: '/v1/admin/audit', reason: 'Platform admins only; staff look across every account.' },
  { method: 'GET', path: '/v1/admin/emails', reason: 'Platform admins only; staff look across every account.' },
  { method: 'GET', path: '/v1/mrl/residues', reason: 'Reference data.' },
  { method: 'GET', path: '/v1/mrl', reason: 'Reference data.' },
  ...['notices', 'notices/:id', 'dashboards/topic', 'firms/search', 'firms/:id', 'import-alerts/:number', 'mrl/residues', 'mrl', 'taxonomy', 'usage'].map((route) => ({
    method: 'GET',
    path: `/v1/public/${route}`,
    reason: "Public API: an API key, not a session, names the account, and only the key's own account is read or charged (public-api.e2e.spec.ts).",
  })),
  { method: 'GET', path: '/v1/public/openapi.json', reason: 'The public API description: the same for everyone, open without a key.' },
  { method: 'POST', path: '/v1/invites/preview', reason: 'The invite token in the body decides the account; the caller needs no session.' },
  { method: 'POST', path: '/v1/invites/accept', reason: 'The invite token in the body decides the account; the caller needs no session.' },
];
