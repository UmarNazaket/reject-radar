import { sql } from 'drizzle-orm';
import { type AccountFixture, ACCOUNT_ROUTES, type IsolationCase, NOT_ACCOUNT_OWNED } from './isolation-registry';
import { joinByInvite, signUpVerified, startTestApp, type TestApp, type TestSession } from './test-app';

interface Account {
  session: TestSession;
  fixture: AccountFixture;
}

/** Express 5 keeps the app's routes in `router.stack`; a layer with a `route` is a handler registered by a controller. */
interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * Middleware that Nest mounts for every method of every path (the request logger's `forRoutes('*')`) shows up as a route
 * answering all methods, with no handler of its own. It is collapsed to `ALL <path>` and skipped by name, so a controller
 * that answers every method on some other path would still be listed and have to be registered.
 */
const GLOBAL_MIDDLEWARE = ['ALL /v1{/*splat}'];
const ALL_METHODS_AT_LEAST = 20;

function registeredRoutes(t: TestApp): string[] {
  const express = t.app.getHttpAdapter().getInstance() as { router: { stack: RouteLayer[] } };
  const routes = express.router.stack
    .filter((layer): layer is Required<RouteLayer> => layer.route !== undefined)
    .flatMap(({ route }) => {
      const methods = Object.keys(route.methods).filter((method) => route.methods[method]);
      return methods.length >= ALL_METHODS_AT_LEAST ? [`ALL ${route.path}`] : methods.map((method) => `${method.toUpperCase()} ${route.path}`);
    })
    .filter((route) => !GLOBAL_MIDDLEWARE.includes(route));
  return [...new Set(routes)].sort();
}

const label = (c: { method: string; path: string }) => `${c.method} ${c.path}`;

describe('account isolation', () => {
  let t: TestApp;
  let a: Account;
  let b: Account;

  beforeAll(async () => {
    t = await startTestApp('api_isolation');
  });

  afterAll(async () => {
    await t.close();
  });

  /** An owner, one member and one pending invite, each on its own address under `tag`. */
  async function buildAccount(tag: string): Promise<Account> {
    const owner = await signUpVerified(t, { email: `${tag}.owner@isolation.test`, name: `${tag} Owner`, company: `${tag} Rice Mills` });
    const member = await joinByInvite(t, owner.session, { email: `${tag}.member@isolation.test`, role: 'member', name: `${tag} Member` });
    const pending = await owner.session.post('/v1/org/invites').send({ email: `${tag}.pending@isolation.test`, role: 'admin' }).expect(201);
    return {
      session: owner.session,
      fixture: {
        orgId: owner.orgId,
        ownerId: owner.userId,
        memberId: member.userId,
        inviteId: (pending.body as { id: string }).id,
        emails: [`${tag}.owner@isolation.test`, `${tag}.member@isolation.test`, `${tag}.pending@isolation.test`],
      },
    };
  }

  /** What an outsider could change in account B: its name, its members and roles, its invites and its users' profiles. */
  async function snapshot(account: Account) {
    const { orgId } = account.fixture;
    const rows = async (query: ReturnType<typeof sql>) => (await t.db.execute(query)).rows;
    return {
      org: await rows(sql`select id, name from org where id = ${orgId}`),
      members: await rows(sql`
        select m.user_id, m.role, u.name, u.email, u.locale
        from membership m join app_user u on u.id = m.user_id
        where m.org_id = ${orgId} order by m.user_id`),
      invites: await rows(sql`select id, email, role, accepted_at from invite where org_id = ${orgId} order by id`),
    };
  }

  const fill = (path: string, params: Record<string, string>) =>
    path.replace(/:(\w+)/g, (_, name: string) => {
      const value = params[name];
      if (value === undefined) throw new Error(`No value for :${name} in ${path}`);
      return value;
    });

  beforeEach(async () => {
    t.resetRateLimits();
    t.mail.sent.length = 0;
    await t.db.execute(sql`truncate app_user, org, email_delivery cascade`);
    a = await buildAccount('a');
    b = await buildAccount('b');
  });

  it('every route is registered', () => {
    const registered = registeredRoutes(t);
    const known = [...ACCOUNT_ROUTES, ...NOT_ACCOUNT_OWNED].map(label);

    const unregistered = registered.filter((route) => !known.includes(route));
    expect({ message: 'Routes in neither ACCOUNT_ROUTES nor NOT_ACCOUNT_OWNED (isolation-registry.ts)', unregistered }).toEqual({
      message: 'Routes in neither ACCOUNT_ROUTES nor NOT_ACCOUNT_OWNED (isolation-registry.ts)',
      unregistered: [],
    });

    const stale = known.filter((route) => !registered.includes(route));
    expect({ message: 'Registry entries for routes the API does not have', stale }).toEqual({
      message: 'Registry entries for routes the API does not have',
      stale: [],
    });
    expect(new Set(known).size).toBe(known.length);
  });

  it('documents a reason for every exemption', () => {
    for (const entry of NOT_ACCOUNT_OWNED) expect({ route: label(entry), reason: entry.reason.trim().length > 0 }).toEqual({ route: label(entry), reason: true });
  });

  describe('account A never reaches account B', () => {
    const send = (session: TestSession, c: IsolationCase, path: string, body: unknown) => {
      const req = session[c.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete'](path);
      return body === undefined ? req : req.send(body as object);
    };

    it.each(ACCOUNT_ROUTES.flatMap((c) => (c.target ? [[label(c), c, c.target] as const] : [])))(
      '%s with account B\'s ids answers 404 and changes nothing',
      async (_name, c, target) => {
        const before = await snapshot(b);
        const path = fill(c.path, target(b.fixture));
        const res = await send(a.session, c, path, c.body?.(b.fixture));
        expect({ route: label(c), status: res.status }).toEqual({ route: label(c), status: 404 });
        expect((res.body as { code: string }).code).toBe('NOT_FOUND');
        expect(await snapshot(b)).toEqual(before);
      },
    );

    it.each(ACCOUNT_ROUTES.filter((c) => !c.target).map((c) => [label(c), c] as const))(
      '%s answers with none of account B\'s data and leaves it unchanged',
      async (_name, c) => {
        const before = await snapshot(b);
        const res = await send(a.session, c, c.path, c.body?.(b.fixture));
        expect(res.status).toBeLessThan(300);

        const text = JSON.stringify(res.body);
        const secrets = [b.fixture.orgId, b.fixture.ownerId, b.fixture.memberId, b.fixture.inviteId, ...b.fixture.emails];
        expect({ route: label(c), leaked: secrets.filter((secret) => text.includes(secret)) }).toEqual({ route: label(c), leaked: [] });
        expect(await snapshot(b)).toEqual(before);
      },
    );

    it('has a case for every account-owned route that takes an id, and each case is filled', () => {
      for (const c of ACCOUNT_ROUTES) {
        const params = c.path.match(/:(\w+)/g) ?? [];
        expect({ route: label(c), hasTarget: c.target !== undefined }).toEqual({ route: label(c), hasTarget: params.length > 0 });
        if (c.target) expect(() => fill(c.path, c.target?.(b.fixture) ?? {})).not.toThrow();
      }
    });
  });
});
