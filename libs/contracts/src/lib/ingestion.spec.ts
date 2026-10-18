import {
  EVENT_KINDS,
  EVENT_SEVERITY,
  LISTS,
  NOTICE_DESTINATION,
  NOTICE_SOURCES,
  NOTICE_TYPES,
  RULE_MATCH_TYPES,
  RULE_SOURCES,
  SEVERITIES,
  SYNC_SOURCES,
  SYNC_STATUSES,
} from './ingestion';

describe('ingestion unions', () => {
  it('maps every event kind to its severity (spec §6.5)', () => {
    expect(EVENT_SEVERITY).toEqual({
      fda_refusal: 'high',
      import_alert_listed: 'high',
      import_alert_delisted: 'normal',
      au_failed_test: 'high',
      rasff_notification: 'normal',
      uk_border_notification: 'normal',
    });
  });

  it('maps every notice source to its destination', () => {
    expect(NOTICE_DESTINATION).toEqual({ fda_refusal: 'US', import_alert: 'US', rasff: 'EU', uk_bn: 'UK', au_ifis: 'AU' });
  });

  it.each([
    ['SYNC_SOURCES', SYNC_SOURCES],
    ['SYNC_STATUSES', SYNC_STATUSES],
    ['NOTICE_SOURCES', NOTICE_SOURCES],
    ['RULE_SOURCES', RULE_SOURCES],
    ['RULE_MATCH_TYPES', RULE_MATCH_TYPES],
    ['NOTICE_TYPES', NOTICE_TYPES],
    ['EVENT_KINDS', EVENT_KINDS],
    ['SEVERITIES', SEVERITIES],
    ['LISTS', LISTS],
  ])('has no duplicates in %s', (_name, values) => {
    expect(new Set(values).size).toBe(values.length);
  });

  it('lets rules target every notice source and any source', () => {
    expect(RULE_SOURCES).toContain('*');
    for (const source of NOTICE_SOURCES) expect(RULE_SOURCES).toContain(source);
  });

  it('gives every event kind a severity and every notice source a destination', () => {
    expect(Object.keys(EVENT_SEVERITY).sort()).toEqual([...EVENT_KINDS].sort());
    expect(Object.keys(NOTICE_DESTINATION).sort()).toEqual([...NOTICE_SOURCES].sort());
  });
});
