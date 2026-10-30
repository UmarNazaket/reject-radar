import type { AdminOrgResponse, AdminOrgsResponse, AuditResponse } from '@rejectradar/contracts';
import { appUser, auditLog } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('admin accounts and audit log', () => {
  let t: TestApp;
  let admin: TestSession;
  let adminId: string;
  let customer: TestSession;
  let customerOrg: string;

  beforeAll(async () => {
    t = await startTestApp('api_admin_accounts');
    const staff = await signUpVerified(t, { email: 'staff@accounts.test', name: 'Hina Staff', company: 'RejectRadar' });
    await t.db.update(appUser).set({ isPlatformAdmin: true }).where(eq(appUser.id, staff.userId));
    ({ session: admin, userId: adminId } = staff);
    ({ session: customer, orgId: customerOrg } = await signUpVerified(t, { email: 'sara@indus-agro.test', name: 'Sara Malik', company: 'Indus Agro' }));
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => t.resetRateLimits());

  it('is for platform admins only', async () => {
    const routes = [
      ['get', '/v1/admin/orgs'],
      ['get', `/v1/admin/orgs/${customerOrg}`],
      ['patch', `/v1/admin/orgs/${customerOrg}`],
      ['get', '/v1/admin/audit'],
    ] as const;
    for (const [method, path] of routes) {
      await t.session()[method](path).expect(401);
      expect((await customer[method](path).expect(403)).body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('finds an account by its name or a member email', async () => {
    const all = (await admin.get('/v1/admin/orgs').expect(200)).body as AdminOrgsResponse;
    expect(all.items.map((o) => o.name)).toEqual(['Indus Agro', 'RejectRadar']);
    for (const q of ['indus', 'SARA@indus']) {
      const { items } = (await admin.get('/v1/admin/orgs').query({ q }).expect(200)).body as AdminOrgsResponse;
      expect(items).toEqual([expect.objectContaining({ id: customerOrg, name: 'Indus Agro', plan: 'free', source: 'free', members: 1 })]);
    }
    expect(((await admin.get('/v1/admin/orgs').query({ q: '100%' }).expect(200)).body as AdminOrgsResponse).items).toEqual([]);
  });

  it('shows an account with its members, plan and usage, and grants and clears a plan override', async () => {
    const before = (await admin.get(`/v1/admin/orgs/${customerOrg}`).expect(200)).body as AdminOrgResponse;
    expect(before).toMatchObject({
      org: { id: customerOrg, name: 'Indus Agro', planOverride: null, deactivatedAt: null },
      plan: 'free',
      source: 'free',
      subscription: null,
      usage: { lookups: 0, members: 1, seats: 1, watchlist: 0 },
      members: [{ name: 'Sara Malik', email: 'sara@indus-agro.test', role: 'owner', emailVerified: true }],
    });

    const granted = (await admin.patch(`/v1/admin/orgs/${customerOrg}`).send({ planOverride: 'enterprise' }).expect(200)).body as AdminOrgResponse;
    expect(granted).toMatchObject({ org: { planOverride: 'enterprise' }, plan: 'enterprise', source: 'override' });
    expect(granted.limits.members).toBeGreaterThan(before.limits.members);
    // The account's own billing page sees the new limits at once.
    expect((await customer.get('/v1/billing/subscription').expect(200)).body).toMatchObject({ plan: 'enterprise', source: 'override' });

    const cleared = (await admin.patch(`/v1/admin/orgs/${customerOrg}`).send({ planOverride: null }).expect(200)).body as AdminOrgResponse;
    expect(cleared).toMatchObject({ org: { planOverride: null }, plan: 'free', source: 'free' });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.targetId, customerOrg));
    expect(audits.map((a) => [a.action, a.actorUserId, a.details])).toEqual([
      ['org.plan_override', adminId, { before: null, after: 'enterprise' }],
      ['org.plan_override', adminId, { before: 'enterprise', after: null }],
    ]);

    await admin.patch(`/v1/admin/orgs/${customerOrg}`).send({ planOverride: 'gold' }).expect(400);
    await admin.get('/v1/admin/orgs/0190f2b4-0000-7000-8000-000000000000').expect(404);
    await admin.get('/v1/admin/orgs/not-a-uuid').expect(404);
  });

  it('reads the audit log newest first, by page and by the start of the action', async () => {
    await t.db.insert(auditLog).values(
      Array.from({ length: 55 }, (_, i) => ({ actorUserId: null, action: i % 2 ? 'firm.merge' : 'firm.split', targetType: 'firm', targetId: String(i) })),
    );
    const first = (await admin.get('/v1/admin/audit').expect(200)).body as AuditResponse;
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).toMatchObject({ action: 'firm.split', targetId: '54', actor: null });
    expect(first.next).not.toBeNull();
    const second = (await admin.get('/v1/admin/audit').query({ cursor: first.next }).expect(200)).body as AuditResponse;
    expect(second.next).toBeNull();
    // 55 firm rows and the two plan overrides of the test before.
    expect(second.items).toHaveLength(7);
    expect(second.items.at(-1)).toMatchObject({ action: 'org.plan_override', actor: { name: 'Hina Staff', email: 'staff@accounts.test' } });

    const merges = (await admin.get('/v1/admin/audit').query({ action: 'firm.m' }).expect(200)).body as AuditResponse;
    expect(merges.items).toHaveLength(27);
    expect(new Set(merges.items.map((i) => i.action))).toEqual(new Set(['firm.merge']));
    await admin.get('/v1/admin/audit').query({ cursor: '-1' }).expect(400);
  });
});
