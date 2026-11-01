import type { AdminOrgResponse, AdminOrgsResponse, AdminUsersResponse, AuditResponse, EmailLogResponse } from '@rejectradar/contracts';
import { appUser, auditLog, emailDelivery, uuidv7 } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('admin accounts and audit log', () => {
  let t: TestApp;
  let admin: TestSession;
  let adminId: string;
  let adminOrg: string;
  let customer: TestSession;
  let customerOrg: string;

  beforeAll(async () => {
    t = await startTestApp('api_admin_accounts');
    const staff = await signUpVerified(t, { email: 'staff@accounts.test', name: 'Hina Staff', company: 'RejectRadar' });
    await t.db.update(appUser).set({ isPlatformAdmin: true }).where(eq(appUser.id, staff.userId));
    ({ session: admin, userId: adminId, orgId: adminOrg } = staff);
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
      ['post', `/v1/admin/orgs/${customerOrg}/deactivate`],
      ['post', `/v1/admin/orgs/${customerOrg}/reactivate`],
      ['get', '/v1/admin/audit'],
      ['get', '/v1/admin/emails'],
      ['get', '/v1/admin/users'],
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

  it('reads the email log newest first, by page and by part of the address', async () => {
    // Sorted: ids made in the same millisecond are not in order among themselves.
    const ids = Array.from({ length: 102 }, () => uuidv7()).sort();
    await t.db.insert(emailDelivery).values(
      ids.map((id, i) => ({ id, toEmail: `Buyer${i}@Paging.test`, kind: 'instant_alert', status: i === 101 ? 'failed' : 'sent', error: i === 101 ? 'Resend 422' : null })),
    );
    const first = (await admin.get('/v1/admin/emails').query({ to: 'paging.TEST' }).expect(200)).body as EmailLogResponse;
    expect(first.items).toHaveLength(100);
    expect(first.items[0]).toMatchObject({ id: ids[101], to: 'Buyer101@Paging.test', kind: 'instant_alert', status: 'failed', error: 'Resend 422' });
    expect(first.next).toBe(ids[2]);
    const second = (await admin.get('/v1/admin/emails').query({ to: 'paging.test', cursor: first.next }).expect(200)).body as EmailLogResponse;
    expect(second).toEqual({ items: [expect.objectContaining({ id: ids[1] }), expect.objectContaining({ id: ids[0] })], next: null });

    // `%` is a character to look for, not a wildcard; the sign-ups' own emails are in the log too.
    expect(((await admin.get('/v1/admin/emails').query({ to: '%' }).expect(200)).body as EmailLogResponse).items).toEqual([]);
    expect(((await admin.get('/v1/admin/emails').query({ to: 'sara@indus' }).expect(200)).body as EmailLogResponse).items[0]).toMatchObject({ kind: 'verify' });
    await admin.get('/v1/admin/emails').query({ cursor: 'not-a-uuid' }).expect(400);
  });

  it('finds people across accounts by part of their email or name, newest first, by page', async () => {
    const users = async (query: Record<string, string>) => (await admin.get('/v1/admin/users').query(query).expect(200)).body as AdminUsersResponse;
    const [sara] = (await users({ q: 'SARA@indus' })).items;
    expect(sara).toMatchObject({ email: 'sara@indus-agro.test', name: 'Sara Malik', verified: true, isPlatformAdmin: false, lockedUntil: null });
    expect(sara.accounts).toEqual([{ id: customerOrg, name: 'Indus Agro', role: 'owner' }]);
    expect((await users({ q: 'hina staff' })).items.map((u) => u.isPlatformAdmin)).toEqual([true]);

    // Locked out only while the lock lasts.
    await t.db.update(appUser).set({ lockedUntil: new Date(Date.now() + 600_000) }).where(eq(appUser.id, sara.id));
    expect((await users({ q: 'sara@indus' })).items[0].lockedUntil).not.toBeNull();
    await t.db.update(appUser).set({ lockedUntil: new Date(Date.now() - 600_000) }).where(eq(appUser.id, sara.id));
    expect((await users({ q: 'sara@indus' })).items[0].lockedUntil).toBeNull();

    // Sorted: ids made in the same millisecond are not in order among themselves.
    const ids = Array.from({ length: 51 }, () => uuidv7()).sort();
    await t.db.insert(appUser).values(ids.map((id, i) => ({ id, email: `person${i}@people.test`, passwordHash: 'x', name: `Person ${i}` })));
    const first = await users({ q: 'people.test' });
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).toMatchObject({ id: ids[50], verified: false, accounts: [] });
    expect(first.next).toBe(ids[1]);
    expect(await users({ q: 'people.test', cursor: first.next as string })).toEqual({ items: [expect.objectContaining({ id: ids[0] })], next: null });
    await admin.get('/v1/admin/users').query({ cursor: 'nope' }).expect(400);
  });

  it('deactivates an account, which locks its members out, and reactivates it', async () => {
    const off = (await admin.post(`/v1/admin/orgs/${customerOrg}/deactivate`).expect(200)).body as AdminOrgResponse;
    expect(off.org.deactivatedAt).not.toBeNull();
    expect((await customer.get('/v1/me').expect(403)).body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
    const { items } = (await admin.get('/v1/admin/orgs').query({ q: 'indus' }).expect(200)).body as AdminOrgsResponse;
    expect(items[0].deactivatedAt).toBe(off.org.deactivatedAt);
    expect((await admin.post(`/v1/admin/orgs/${customerOrg}/deactivate`).expect(409)).body.message).toBe('This account is deactivated already.');

    const on = (await admin.post(`/v1/admin/orgs/${customerOrg}/reactivate`).expect(200)).body as AdminOrgResponse;
    expect(on.org.deactivatedAt).toBeNull();
    await customer.get('/v1/me').expect(200);
    const actions = (await t.db.select().from(auditLog).where(eq(auditLog.targetId, customerOrg))).map((a) => [a.action, a.actorUserId]);
    expect(actions.slice(-2)).toEqual([
      ['org.deactivate', adminId],
      ['org.reactivate', adminId],
    ]);

    // Staff would lock themselves out.
    expect((await admin.post(`/v1/admin/orgs/${adminOrg}/deactivate`).expect(409)).body.message).toBe('You cannot deactivate your own account.');
    await admin.post('/v1/admin/orgs/0190f2b4-0000-7000-8000-000000000000/reactivate').expect(404);
  });
});
