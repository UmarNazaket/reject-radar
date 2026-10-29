import { BULK_JOB_STATUSES, BULK_LIMITS, BULK_ROW_STATUSES, bulkRowReviewRequest } from './bulk';

describe('bulk contracts', () => {
  it('lists the job and row statuses', () => {
    expect(BULK_JOB_STATUSES).toEqual(['queued', 'running', 'finished']);
    expect(BULK_ROW_STATUSES).toEqual(['pending', 'matched', 'review', 'no_record', 'confirmed', 'rejected']);
  });

  it('fixes the upload limits', () => {
    expect(BULK_LIMITS).toEqual({
      maxBytes: 2 * 1024 * 1024,
      maxRows: 5000,
      batchSize: 50,
      concurrency: 2,
      staleAfterSec: 60,
      pageSize: 100,
      maxProblems: 20,
      maxNameLength: 300,
      maxCityLength: 120,
      maxRowAttempts: 3,
    });
  });

  describe('bulkRowReviewRequest', () => {
    it('accepts a confirm with a firm and a bare reject', () => {
      expect(bulkRowReviewRequest.parse({ action: 'confirm', firmId: 7 })).toEqual({ action: 'confirm', firmId: 7 });
      expect(bulkRowReviewRequest.parse({ action: 'reject' })).toEqual({ action: 'reject' });
    });

    it('rejects a confirm without a firm id', () => {
      expect(bulkRowReviewRequest.safeParse({ action: 'confirm' }).success).toBe(false);
    });

    it('rejects an unknown action and a bad firm id', () => {
      expect(bulkRowReviewRequest.safeParse({ action: 'delete' }).success).toBe(false);
      expect(bulkRowReviewRequest.safeParse({ action: 'confirm', firmId: 0 }).success).toBe(false);
      expect(bulkRowReviewRequest.safeParse({ action: 'confirm', firmId: 1.5 }).success).toBe(false);
    });
  });
});
