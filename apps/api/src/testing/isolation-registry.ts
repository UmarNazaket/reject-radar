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
  /** The owner's, the member's and the pending invite's email addresses. */
  emails: string[];
}

export interface IsolationCase {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** The route as Express lists it, with `:params`, for example `/v1/org/members/:userId`. */
  path: string;
  /** A valid request body for the route, built from account B's fixture when it needs one. */
  body?: (b: AccountFixture) => unknown;
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
  { method: 'GET', path: '/v1/taxonomy', reason: 'Reference data; the same for every caller.' },
  { method: 'POST', path: '/v1/invites/preview', reason: 'The invite token in the body decides the account; the caller needs no session.' },
  { method: 'POST', path: '/v1/invites/accept', reason: 'The invite token in the body decides the account; the caller needs no session.' },
];
