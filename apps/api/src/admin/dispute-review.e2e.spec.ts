import type { DecideDisputeResponse, DisputeReviewResponse } from '@rejectradar/contracts';
import { translate } from '@rejectradar/i18n';
import { appUser, auditLog, dispute, uuidv7 } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { type ReferenceFixture, seedReferenceData } from '../testing/reference-data';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('admin dispute review', () => {
  let t: TestApp;
  let fx: ReferenceFixture;
  let admin: TestSession;
  let adminId: string;
  let customer: TestSession;
  let customerOrg: string;

  beforeAll(async () => {
    t = await startTestApp('api_admin_disputes');
    fx = await seedReferenceData(t.db);
    const staff = await signUpVerified(t, { email: 'staff@disputes.test' });
    await t.db.update(appUser).set({ isPlatformAdmin: true }).where(eq(appUser.id, staff.userId));
    ({ session: admin, userId: adminId } = staff);
    ({ session: customer, orgId: customerOrg } = await signUpVerified(t, { email: 'sara@disputes.test', name: 'Sara Malik', company: 'Indus Agro', locale: 'ur' }));
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => t.resetRateLimits());

  const report = async (message: string): Promise<string> =>
    (await customer.post(`/v1/firms/${fx.firms.zarfeen}/disputes`).send({ kind: 'wrong_details', message }).expect(201)).body.id as string;

  it('is for platform admins only', async () => {
    const id = uuidv7();
    await t.session().get('/v1/admin/disputes').expect(401);
    await t.session().patch(`/v1/admin/disputes/${id}`).expect(401);
    expect((await customer.get('/v1/admin/disputes').expect(403)).body).toMatchObject({ code: 'FORBIDDEN' });
    await customer.patch(`/v1/admin/disputes/${id}`).send({ status: 'resolved', resolution: 'x' }).expect(403);
  });

  it('lists open disputes with the account, the reporter and the firm', async () => {
    const id = await report('The city of this firm is wrong.');
    const { items } = (await admin.get('/v1/admin/disputes').expect(200)).body as DisputeReviewResponse;
    expect(items.find((item) => item.id === id)).toMatchObject({
      kind: 'wrong_details',
      message: 'The city of this firm is wrong.',
      status: 'open',
      resolution: null,
      record: null,
      org: { id: customerOrg, name: 'Indus Agro' },
      reporter: { name: 'Sara Malik', email: 'sara@disputes.test' },
      firm: { id: fx.firms.zarfeen, records: 5 },
      resolvedAt: null,
    });
  });

  it('resolves a dispute once, audits it and emails the reporter in their language', async () => {
    const id = await report('The address of this firm is out of date.');
    t.mail.sent.length = 0;
    const body = (await admin.patch(`/v1/admin/disputes/${id}`).send({ status: 'resolved', resolution: '  We updated the address.  ' }).expect(200))
      .body as DecideDisputeResponse;
    expect(body.emailed).toBe(true);
    expect(body.item).toMatchObject({ id, status: 'resolved', resolution: 'We updated the address.' });
    expect(body.item.resolvedAt).not.toBeNull();

    const email = t.mail.lastTo('sara@disputes.test');
    expect(email.subject).toBe(translate('ur', 'email.disputeResolved.subject'));
    expect(email.text).toContain('We updated the address.');
    expect(email.text).toContain(`http://localhost:4200/firms/${fx.firms.zarfeen}`);
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(audit).toMatchObject({ actorUserId: adminId, action: 'dispute.resolve', targetType: 'dispute' });

    // A decided dispute cannot be decided again, and leaves the open list.
    expect((await admin.patch(`/v1/admin/disputes/${id}`).send({ status: 'rejected', resolution: 'No.' }).expect(409)).body).toMatchObject({ code: 'CONFLICT' });
    const open = (await admin.get('/v1/admin/disputes').expect(200)).body as DisputeReviewResponse;
    expect(open.items.map((item) => item.id)).not.toContain(id);
    const resolved = (await admin.get('/v1/admin/disputes').query({ status: 'resolved' }).expect(200)).body as DisputeReviewResponse;
    expect(resolved.items.map((item) => item.id)).toContain(id);
  });

  it('rejects a dispute whose reporter has left without emailing anyone', async () => {
    const id = uuidv7();
    await t.db.insert(dispute).values({ id, orgId: customerOrg, userId: null, firmId: fx.firms.zarfeen, source: 'fda_refusal', sourceKey: 'k-1', kind: 'wrong_firm', message: 'This refusal is not ours.' });
    t.mail.sent.length = 0;
    const body = (await admin.patch(`/v1/admin/disputes/${id}`).send({ status: 'rejected', resolution: 'The FEI matches this firm.' }).expect(200))
      .body as DecideDisputeResponse;
    expect(body).toMatchObject({ emailed: false, item: { status: 'rejected', reporter: null, record: { source: 'fda_refusal', key: 'k-1' } } });
    expect(t.mail.sent).toHaveLength(0);
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(audit.action).toBe('dispute.reject');
  });

  it('answers 404 for a dispute that is not there, and 400 for a bad body or status', async () => {
    await admin.patch(`/v1/admin/disputes/${uuidv7()}`).send({ status: 'resolved', resolution: 'Done.' }).expect(404);
    await admin.patch('/v1/admin/disputes/not-a-uuid').send({ status: 'resolved', resolution: 'Done.' }).expect(404);
    const id = await report('Something else is wrong here.');
    await admin.patch(`/v1/admin/disputes/${id}`).send({ status: 'open', resolution: 'Done.' }).expect(400);
    await admin.patch(`/v1/admin/disputes/${id}`).send({ status: 'resolved', resolution: '   ' }).expect(400);
    await admin.get('/v1/admin/disputes').query({ status: 'maybe' }).expect(400);
  });
});
