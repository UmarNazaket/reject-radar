import { type FreshnessSource, STALE_AFTER_DAYS } from '@rejectradar/contracts';
import { sourceSyncRun } from '@rejectradar/db';
import { seedReferenceData, daysAgo } from '../testing/reference-data';
import { startTestApp, type TestApp } from '../testing/test-app';
import { FreshnessService } from './freshness.service';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('FreshnessService', () => {
  let t: TestApp;
  let freshness: FreshnessService;

  beforeAll(async () => {
    t = await startTestApp('api_freshness');
    await seedReferenceData(t.db);
    freshness = t.app.get(FreshnessService);
  });

  afterAll(async () => {
    await t.close();
  });

  /** A run of `source` that finished `days` days ago. */
  const run = async (source: string, days: number, extra: Partial<typeof sourceSyncRun.$inferInsert> = {}) => {
    const finishedAt = new Date(Date.now() - days * DAY_MS);
    await t.db
      .insert(sourceSyncRun)
      .values({ source, status: 'succeeded', startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, ...extra });
  };
  const of = async (source: FreshnessSource) => (await freshness.all()).find((f) => f.source === source);

  it('lists the six sources, each with its latest success', async () => {
    const all = await freshness.all();
    expect(all.map((f) => f.source)).toEqual(['fda_refusals', 'import_alerts', 'rasff', 'uk_bn', 'au_ifis', 'eu_mrl']);
    const rasff = all.find((f) => f.source === 'rasff');
    expect(rasff?.stale).toBe(false);
    expect(new Date(rasff?.lastSuccessAt as string).getTime()).toBeLessThan(Date.now());
  });

  it('eu_mrl at 50 days is stale and rasff at 2 days is not', async () => {
    await t.db.delete(sourceSyncRun);
    await run('eu_mrl', 50);
    await run('rasff', 2);
    expect(STALE_AFTER_DAYS.eu_mrl).toBe(45);
    expect(await of('eu_mrl')).toMatchObject({ stale: true });
    expect(await of('rasff')).toMatchObject({ stale: false });
    expect(await of('uk_bn')).toEqual({ source: 'uk_bn', lastSuccessAt: null, stale: true, latestMonth: expect.any(String) });
  });

  it('uses the latest success, not a later failure or a running run', async () => {
    await t.db.delete(sourceSyncRun);
    await run('rasff', 2);
    await run('rasff', 0.1, { status: 'failed', error: 'boom' });
    await run('rasff', 0.05, { status: 'running', finishedAt: null });
    const rasff = await of('rasff');
    expect(rasff?.stale).toBe(false);
    expect(Date.now() - new Date(rasff?.lastSuccessAt as string).getTime()).toBeGreaterThan(1.9 * DAY_MS);
  });

  it('a partial import-alerts run does not count', async () => {
    await t.db.delete(sourceSyncRun);
    await run('import_alerts', 0.1, { partial: true });
    expect(await of('import_alerts')).toMatchObject({ lastSuccessAt: null, stale: true });
    await run('import_alerts', 1);
    expect(await of('import_alerts')).toMatchObject({ stale: false });
  });

  it('uk_bn latestMonth is the month of the newest notification', async () => {
    expect(await of('uk_bn')).toMatchObject({ latestMonth: daysAgo(30).slice(0, 7) });
    expect(await of('au_ifis')).toMatchObject({ latestMonth: daysAgo(40).slice(0, 7) });
    expect(await of('rasff')).toMatchObject({ latestMonth: null });
    expect(await of('eu_mrl')).toMatchObject({ latestMonth: null });
  });
});
