import { buildTopicKey, FRESHNESS_SOURCES, STALE_AFTER_DAYS, utcPeriod } from './product';

describe('product contracts', () => {
  it('builds topic keys with stars', () => {
    expect(buildTopicKey({ originCountry: 'PK', commodityId: 101, destination: null, hazardId: null })).toBe('PK|101|*|*');
    expect(buildTopicKey({ originCountry: 'PK', commodityId: 101, destination: 'EU', hazardId: 300 })).toBe('PK|101|EU|300');
  });

  it('utcPeriod uses UTC', () => {
    expect(utcPeriod(new Date('2026-10-31T23:30:00-05:00'))).toBe('2026-11');
  });

  it('stale thresholds cover every freshness source', () => {
    expect(Object.keys(STALE_AFTER_DAYS).sort()).toEqual([...FRESHNESS_SOURCES].sort());
  });
});
