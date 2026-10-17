import { BULK_MAX_BYTES, BULK_MAX_ROWS, isPlanId, PLAN_IDS, PLANS } from './plans';

describe('PLANS', () => {
  it('matches the table in spec §10.1', () => {
    expect(PLANS.free).toMatchObject({
      monthlyPriceUsd: 0, lookupsPerMonth: 10, watchlistSize: 3, members: 1, pdf: false, bulk: false,
      bulkRowsPerMonth: 0, apiCallsPerMonth: 0, noticeHistoryMonths: 12,
    });
    expect(PLANS.pro).toMatchObject({
      monthlyPriceUsd: 39, yearlyPriceUsd: 390, lookupsPerMonth: 200, watchlistSize: 25, members: 3, pdf: true, bulk: false,
      bulkRowsPerMonth: 0, apiCallsPerMonth: 0, noticeHistoryMonths: null,
    });
    expect(PLANS.business).toMatchObject({
      monthlyPriceUsd: 149, yearlyPriceUsd: 1490, lookupsPerMonth: 2000, watchlistSize: 250, members: 10, pdf: true, bulk: true,
      bulkRowsPerMonth: 5000, apiCallsPerMonth: 10000, noticeHistoryMonths: null,
    });
    expect(PLANS.enterprise).toMatchObject({
      monthlyPriceUsd: null, yearlyPriceUsd: null, lookupsPerMonth: 20000, watchlistSize: 2500, members: 50, pdf: true, bulk: true,
      bulkRowsPerMonth: 50000, apiCallsPerMonth: 100000, noticeHistoryMonths: null,
    });
  });

  it('never gives a higher plan lower limits than the plan below it', () => {
    const history = (months: number | null) => (months === null ? Number.POSITIVE_INFINITY : months);
    for (let i = 1; i < PLAN_IDS.length; i++) {
      const lower = PLANS[PLAN_IDS[i - 1]];
      const higher = PLANS[PLAN_IDS[i]];
      for (const key of ['lookupsPerMonth', 'watchlistSize', 'members', 'bulkRowsPerMonth', 'apiCallsPerMonth'] as const) {
        expect(higher[key]).toBeGreaterThanOrEqual(lower[key]);
      }
      expect(history(higher.noticeHistoryMonths)).toBeGreaterThanOrEqual(history(lower.noticeHistoryMonths));
      if (lower.pdf) expect(higher.pdf).toBe(true);
      if (lower.bulk) expect(higher.bulk).toBe(true);
    }
  });

  it('gives bulk rows exactly to the plans with bulk screening', () => {
    for (const id of PLAN_IDS) expect(PLANS[id].bulk).toBe(PLANS[id].bulkRowsPerMonth > 0);
  });

  it('prices yearly self-serve plans at 10 months (2 months free)', () => {
    for (const id of PLAN_IDS) {
      const plan = PLANS[id];
      if (plan.monthlyPriceUsd !== null) expect(plan.yearlyPriceUsd).toBe(plan.monthlyPriceUsd * 10);
    }
  });

  it('exposes the bulk upload limits from spec §8.4', () => {
    expect(BULK_MAX_ROWS).toBe(5000);
    expect(BULK_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('recognises plan ids', () => {
    expect(isPlanId('business')).toBe(true);
    expect(isPlanId('gold')).toBe(false);
  });
});
