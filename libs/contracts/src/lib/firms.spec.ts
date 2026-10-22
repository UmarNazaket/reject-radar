import {
  FIRM_FACT_WINDOWS,
  FIRM_RECORD_SOURCES,
  firmFlagsSchema,
  firmMetricsSchema,
  MATCH_REVIEW_REASONS,
  MATCH_REVIEW_STATUSES,
} from './firms';
import { NOTICE_SOURCES } from './ingestion';

describe('firm unions', () => {
  it('link only records of sources that produce notices', () => {
    for (const source of FIRM_RECORD_SOURCES) expect(NOTICE_SOURCES).toContain(source);
  });

  it.each([
    ['FIRM_RECORD_SOURCES', FIRM_RECORD_SOURCES],
    ['MATCH_REVIEW_REASONS', MATCH_REVIEW_REASONS],
    ['MATCH_REVIEW_STATUSES', MATCH_REVIEW_STATUSES],
  ])('have no duplicates in %s', (_name, values) => {
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('firmFlagsSchema (spec §9.4)', () => {
  const flags = {
    import_alert_red: [{ alert: '99-08', listed_on: '2025-03-14' }],
    import_alert_green: [{ alert: '66-41', listed_on: null }],
    fda_refusals_12m: 2,
    fda_refusals_3y: 5,
    au_failed_3y: 1,
    au_holding_order: true,
    top_hazards_3y: ['pesticide_residues', 'microbiological', 'filth'],
  };

  it('parses a full sample', () => {
    expect(firmFlagsSchema.parse(flags)).toEqual(flags);
  });

  it('parses a firm with no facts', () => {
    const none = {
      import_alert_red: [],
      import_alert_green: [],
      fda_refusals_12m: 0,
      fda_refusals_3y: 0,
      au_failed_3y: 0,
      au_holding_order: false,
      top_hazards_3y: [],
    };
    expect(firmFlagsSchema.parse(none)).toEqual(none);
  });

  it('keeps three top hazards and rejects four', () => {
    expect(firmFlagsSchema.safeParse({ ...flags, top_hazards_3y: ['a', 'b', 'c'] }).success).toBe(true);
    expect(firmFlagsSchema.safeParse({ ...flags, top_hazards_3y: ['a', 'b', 'c', 'd'] }).success).toBe(false);
  });

  it.each([
    ['a negative count', { fda_refusals_12m: -1 }],
    ['a fractional count', { au_failed_3y: 0.5 }],
    ['a listing date that is not YYYY-MM-DD', { import_alert_red: [{ alert: '99-08', listed_on: '14 March 2025' }] }],
    ['a missing holding-order fact', { au_holding_order: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(firmFlagsSchema.safeParse({ ...flags, ...patch }).success).toBe(false);
  });

  it('names the counts after the windows they cover', () => {
    const { recentMonths, historyYears } = FIRM_FACT_WINDOWS;
    expect(Object.keys(firmFlagsSchema.shape)).toEqual(
      expect.arrayContaining([
        `fda_refusals_${recentMonths}m`,
        `fda_refusals_${historyYears}y`,
        `au_failed_${historyYears}y`,
        `top_hazards_${historyYears}y`,
      ]),
    );
  });
});

describe('firmMetricsSchema', () => {
  const metrics = {
    fda_refusals_total: 12,
    au_failed_total: 3,
    import_alert_red_current: 1,
    import_alert_green_current: 0,
  };

  it('parses a full sample', () => {
    expect(firmMetricsSchema.parse(metrics)).toEqual(metrics);
  });

  it.each([
    ['a negative count', { au_failed_total: -1 }],
    ['a fractional count', { fda_refusals_total: 1.5 }],
    ['a missing count', { import_alert_red_current: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(firmMetricsSchema.safeParse({ ...metrics, ...patch }).success).toBe(false);
  });
});
