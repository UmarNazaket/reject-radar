import type { AdminSourcesResponse } from '@rejectradar/contracts';
import { appUser, emailDelivery, sourceSyncRun, uuidv7 } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { signUpVerified, startTestApp, type TestApp, type TestSession } from '../testing/test-app';

describe('admin source health', () => {
  let t: TestApp;
  let admin: TestSession;
  let user: TestSession;

  beforeAll(async () => {
    t = await startTestApp('api_admin_sources');
    const staff = await signUpVerified(t, { email: 'staff@sources.test' });
    await t.db.update(appUser).set({ isPlatformAdmin: true }).where(eq(appUser.id, staff.userId));
    admin = staff.session;
    ({ session: user } = await signUpVerified(t, { email: 'customer@sources.test' }));
    // Twelve RASFF runs a day apart, the newest failed, and one partial Import Alert run.
    await t.db.insert(sourceSyncRun).values([
      ...Array.from({ length: 12 }, (_, i) => ({
        source: 'rasff',
        status: i === 0 ? 'failed' : 'succeeded',
        startedAt: new Date(Date.UTC(2026, 9, 28 - i, 3)),
        finishedAt: new Date(Date.UTC(2026, 9, 28 - i, 3, 5)),
        rowsRead: 100 + i,
        error: i === 0 ? 'HTTP 503 from the RASFF portal' : null,
      })),
      { source: 'import_alerts', status: 'succeeded', startedAt: new Date(Date.UTC(2026, 9, 27, 9)), partial: true },
    ]);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => t.resetRateLimits());

  it('is for platform admins only', async () => {
    await t.session().get('/v1/admin/sources').expect(401);
    expect((await user.get('/v1/admin/sources').expect(403)).body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lists every source with its freshness and newest runs', async () => {
    const { sources } = (await admin.get('/v1/admin/sources').expect(200)).body as AdminSourcesResponse;
    expect(sources.map((s) => s.source)).toEqual(['fda_charge_codes', 'fda_refusals', 'import_alerts', 'rasff', 'uk_bn', 'au_ifis', 'eu_mrl']);
    expect(sources[0].freshness).toBeNull();

    const rasff = sources.find((s) => s.source === 'rasff');
    expect(rasff?.runs).toHaveLength(10);
    expect(rasff?.runs[0]).toMatchObject({ status: 'failed', error: 'HTTP 503 from the RASFF portal', rowsRead: 100, startedAt: '2026-10-28T03:00:00.000Z' });
    expect(rasff?.runs[9].rowsRead).toBe(109);
    // The latest successful run counts for freshness, not the failed one after it.
    expect(rasff?.freshness?.lastSuccessAt).toBe('2026-10-27T03:05:00.000Z');

    const importAlerts = sources.find((s) => s.source === 'import_alerts');
    expect(importAlerts?.runs[0]).toMatchObject({ partial: true });
    expect(importAlerts?.freshness).toMatchObject({ lastSuccessAt: null, stale: true });
  });

  it('shows the database size and the emails counted against today\'s cap', async () => {
    const before = ((await admin.get('/v1/admin/sources').expect(200)).body as AdminSourcesResponse).emails.sentToday;
    // A sent and a failed email today, and a sent one yesterday: only the first counts.
    await t.db.insert(emailDelivery).values([
      { id: uuidv7(), toEmail: 'a@sources.test', kind: 'verify', status: 'sent' },
      { id: uuidv7(), toEmail: 'b@sources.test', kind: 'verify', status: 'failed' },
      { id: uuidv7(), toEmail: 'c@sources.test', kind: 'verify', status: 'sent', createdAt: new Date(Date.now() - 2 * 86_400_000) },
    ]);
    const { database, emails } = (await admin.get('/v1/admin/sources').expect(200)).body as AdminSourcesResponse;
    expect(database.limitBytes).toBe(900 * 1024 * 1024);
    expect(database.sizeBytes).toBeGreaterThan(0);
    expect(emails).toEqual({ sentToday: before + 1, cap: 100 });
  });
});
