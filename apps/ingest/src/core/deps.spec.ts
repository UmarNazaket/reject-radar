import { prepareTestDatabase } from '@rejectradar/db';
import { classifyCommodity } from '@rejectradar/taxonomy';
import { createDeps, utcToday } from './deps';
import { loadIngestEnv } from './env';

describe('createDeps', () => {
  it('composes the database, fetcher, rules and a UTC clock', async () => {
    const env = loadIngestEnv({
      DATABASE_URL: await prepareTestDatabase('ingest_deps'),
      INGEST_CONTACT_EMAIL: 'ops@example.org',
    });
    const deps = await createDeps(env);
    try {
      expect(typeof deps.fetcher).toBe('function');
      expect(classifyCommodity(deps.rules, 'fda_refusal', { product_desc: 'CUMIN SEED' })).toBe(203);
      expect(deps.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      await deps.close();
    }
  });
});

describe('utcToday', () => {
  afterEach(() => jest.useRealTimers());

  it('uses the UTC date, not the local one', () => {
    jest.useFakeTimers({ now: new Date('2026-10-18T23:30:00-05:00') });
    expect(utcToday()).toBe('2026-10-19');
  });
});
