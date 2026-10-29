import { z } from 'zod';
import type { FirmSearchLabel } from './firm-api';

export const BULK_JOB_STATUSES = ['queued', 'running', 'finished'] as const;
export type BulkJobStatus = (typeof BULK_JOB_STATUSES)[number];

export const BULK_ROW_STATUSES = ['pending', 'matched', 'review', 'no_record', 'confirmed', 'rejected'] as const;
export type BulkRowStatus = (typeof BULK_ROW_STATUSES)[number];

/** The delimiters an upload may use (P6-D2); the export is written in the upload's own. */
export const BULK_DELIMITERS = [',', ';'] as const;
export type BulkDelimiter = (typeof BULK_DELIMITERS)[number];

/** Upload and processing limits (spec §8.4, §9.8, P6-D2, P6-D5). */
export const BULK_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxRows: 5000,
  /** Rows read from the database and matched per batch. */
  batchSize: 50,
  /** Rows matched at the same time; the pool has 5 connections, so 3 stay free for requests. */
  concurrency: 2,
  /** A running job whose heartbeat is older than this is resumed. */
  staleAfterSec: 60,
  /** How often each API process looks for stale jobs to resume, besides its startup scan. */
  sweepEverySec: 60,
  /** Rows per page of results. */
  pageSize: 100,
  /** Problems listed in an `INVALID_ROWS` answer. */
  maxProblems: 20,
  /** Longest `name` and `city` cells accepted, in characters after trimming; longer is `too_long`. */
  maxNameLength: 300,
  maxCityLength: 120,
  /** Failed attempts after which a row that cannot be matched is written `no_record`, so its job still finishes. */
  maxRowAttempts: 3,
} as const;

/** One possible firm for a row, as stored in `bulk_job_row.candidates`. */
export interface BulkCandidate {
  firmId: number;
  displayName: string;
  countryCode: string | null;
  city: string | null;
  /** 0 to 1, four decimals. */
  score: number;
  label: FirmSearchLabel;
}

/** `PATCH /v1/bulk-jobs/:id/rows/:rowId` (P6-D7): confirm one of the row's candidates, or reject the row. */
export const bulkRowReviewRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), firmId: z.number().int().min(1).max(2147483647) }),
  z.object({ action: z.literal('reject') }),
]);
export type BulkRowReviewRequest = z.output<typeof bulkRowReviewRequest>;

export interface BulkJobResponse {
  id: string;
  fileName: string;
  status: BulkJobStatus;
  total: number;
  processed: number;
  /** ISO 8601 timestamps. */
  createdAt: string;
  finishedAt: string | null;
}

/** `GET /v1/bulk-jobs`: the account's newest 50 jobs. */
export interface BulkJobListResponse {
  jobs: BulkJobResponse[];
}

export interface BulkRowResponse {
  id: number;
  rowNr: number;
  input: { name: string; country: string | null; city: string | null; fei: string | null };
  status: BulkRowStatus;
  /**
   * True for a `no_record` row whose search failed `BULK_LIMITS.maxRowAttempts` times: nothing was found because the search
   * never ran to the end, not because no record exists. The export prints its status as `search_failed`.
   */
  failed: boolean;
  score: number | null;
  firm: { id: number; displayName: string; countryCode: string | null } | null;
  /** Summary facts of the matched firm; null for a row without one. */
  facts: { fdaRefusals3y: number; importAlertRed: boolean; auFailed3y: number } | null;
  candidates: BulkCandidate[];
}

/** `GET /v1/bulk-jobs/:id/rows`: `nextCursor` is null on the last page. */
export interface BulkRowsResponse {
  rows: BulkRowResponse[];
  nextCursor: string | null;
}

/** `POST /v1/bulk-jobs/:id/watch-confirmed` (P6-D8). */
export interface WatchConfirmedResponse {
  added: number;
  alreadyWatched: number;
  overLimit: number;
}
