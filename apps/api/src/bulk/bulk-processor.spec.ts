import { labelQueryScore } from '@rejectradar/matching';
import type { FirmSearchHit } from '../firms/firm-search.service';
import { DrizzleQueryError } from 'drizzle-orm';
import { classifyRow, isConnectionError } from './bulk-processor';

/** A search hit for firm `id` with `score`; the label is the one the search would give that score. */
const hit = (id: number, score: number): FirmSearchHit => {
  const label = labelQueryScore(score);
  return {
    id,
    displayName: `Firm ${id}`,
    label: label === 'hidden' ? 'other' : label,
    score,
    countryCode: 'PK',
    city: 'lahore',
    region: 'Punjab',
    commodityIds: [101],
    lastNoticeOn: '2026-01-15',
    evidence: { sim: score, cityMatch: false, uniqueNearExact: false, byFei: false },
  };
};

describe('classifyRow (P6-D6)', () => {
  it('a top score of 0.91 is matched, with the firm and its score', () => {
    expect(classifyRow([hit(7, 0.91), hit(8, 0.8)])).toEqual({
      status: 'matched',
      firmId: 7,
      score: 0.91,
      candidates: [
        { firmId: 7, displayName: 'Firm 7', countryCode: 'PK', city: 'lahore', score: 0.91, label: 'strong' },
        { firmId: 8, displayName: 'Firm 8', countryCode: 'PK', city: 'lahore', score: 0.8, label: 'possible' },
      ],
    });
  });

  it('0.90 is matched; just under it is review', () => {
    expect(classifyRow([hit(1, 0.9)]).status).toBe('matched');
    expect(classifyRow([hit(1, 0.8999)]).status).toBe('review');
  });

  it('0.85 is review: no firm, the top score kept', () => {
    expect(classifyRow([hit(3, 0.85)])).toEqual({
      status: 'review',
      firmId: null,
      score: 0.85,
      candidates: [{ firmId: 3, displayName: 'Firm 3', countryCode: 'PK', city: 'lahore', score: 0.85, label: 'possible' }],
    });
  });

  it('0.75 is review; just under it is no_record', () => {
    expect(classifyRow([hit(1, 0.75)]).status).toBe('review');
    expect(classifyRow([hit(1, 0.7499)]).status).toBe('no_record');
  });

  it('0.60 is no_record, with the candidate kept and its score stored', () => {
    expect(classifyRow([hit(4, 0.6)])).toEqual({
      status: 'no_record',
      firmId: null,
      score: 0.6,
      candidates: [{ firmId: 4, displayName: 'Firm 4', countryCode: 'PK', city: 'lahore', score: 0.6, label: 'other' }],
    });
  });

  it('no hits is no_record with no score and no candidates', () => {
    expect(classifyRow([])).toEqual({ status: 'no_record', firmId: null, score: null, candidates: [] });
  });

  it('five hits keep the top 3', () => {
    const result = classifyRow([hit(1, 0.95), hit(2, 0.9), hit(3, 0.8), hit(4, 0.7), hit(5, 0.6)]);
    expect(result.candidates.map((c) => c.firmId)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ status: 'matched', firmId: 1, score: 0.95 });
  });

  it('a hit below 0.50 is dropped, and only such hits is no_record without a score', () => {
    expect(classifyRow([hit(1, 0.8), hit(2, 0.4999)]).candidates.map((c) => c.firmId)).toEqual([1]);
    expect(classifyRow([hit(2, 0.4999)])).toEqual({ status: 'no_record', firmId: null, score: null, candidates: [] });
    expect(classifyRow([hit(2, 0.5)]).candidates.map((c) => c.firmId)).toEqual([2]);
  });

  it('a firm found by its FEI (score 1) is matched', () => {
    expect(classifyRow([{ ...hit(9, 1), evidence: { sim: 1, cityMatch: false, uniqueNearExact: false, byFei: true } }])).toMatchObject({
      status: 'matched',
      firmId: 9,
      score: 1,
    });
  });
});

describe('isConnectionError', () => {
  const withCode = (code: string) => Object.assign(new Error(`failed: ${code}`), { code });

  it('recognises socket errors and Postgres connection codes, also inside a Drizzle error', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '08006', '08P01', '57P01']) {
      expect({ code, connection: isConnectionError(withCode(code)) }).toEqual({ code, connection: true });
    }
    expect(isConnectionError(new DrizzleQueryError('select 1', [], withCode('ECONNRESET')))).toBe(true);
    expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionError(new Error('Cannot use a pool after calling end on the pool'))).toBe(true);
  });

  it('leaves errors about the row itself to count against the row', () => {
    for (const code of ['22003', '23503', '22P02', '42601']) {
      expect({ code, connection: isConnectionError(withCode(code)) }).toEqual({ code, connection: false });
    }
    expect(isConnectionError(new DrizzleQueryError('update bulk_job_row', [], withCode('22003')))).toBe(false);
    expect(isConnectionError(new Error('this row cannot be matched'))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
    expect(isConnectionError('ECONNRESET')).toBe(false);
  });
});
