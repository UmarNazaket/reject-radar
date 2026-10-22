import type { FirmRecordSource, MatchReviewReason } from '@rejectradar/contracts';
import type { Database } from '@rejectradar/db';
import type { LinkEvidence, LinkScoreParts, NormalizedAddress } from '@rejectradar/matching';

/** The handle `db.transaction` passes to its callback. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

/** An unlinked record that names a firm: an FDA refusal, an Import Alert listing or an Australian failed test. */
export interface FirmRecord {
  source: FirmRecordSource;
  /** The record's key in its source table. */
  key: string;
  /** The FDA Establishment Identifier; only FDA refusals carry one. */
  fei: number | null;
  /** The firm's name as the source writes it. */
  firmName: string;
  nameNorm: string;
  address: NormalizedAddress | null;
  commodityIds: number[];
  /** The record's date, YYYY-MM-DD. */
  seenOn: string;
}

/**
 * A name in the population whose tokens are counted to tell a distinctive name (P3-D4): a firm's or a firm-level
 * record's `name_norm`, under its `country_code`.
 */
export interface FrequencyName {
  countryCode: string | null;
  nameNorm: string;
}

/** A firm in the database that can still receive records (not merged away), with the FEIs it holds. */
export interface KnownFirm {
  id: number;
  nameNorm: string;
  address: NormalizedAddress | null;
  commodityIds: number[];
  feis: number[];
}

/** A firm in a plan: one in the database, or the plan's new firm at `index`. */
export type FirmRef = { kind: 'existing'; id: number } | { kind: 'new'; index: number };

/** A firm the plan creates, with the name and address of the record given by `source` and `key` (P3-D6). */
export interface NewFirm {
  index: number;
  displayName: string;
  nameNorm: string;
  address: NormalizedAddress | null;
  /** The earliest date among the records that created the firm. */
  firstSeen: string;
  source: FirmRecordSource;
  key: string;
}

/** A record's firm, and the score stored with the link (`link_score`). */
export interface RecordLink {
  source: FirmRecordSource;
  key: string;
  firm: FirmRef;
  score: number;
}

/** A `firm_fei` row. `firstSeen` is the date of the FEI's earliest refusal in the run. */
export interface FeiAssignment {
  fei: number;
  firm: FirmRef;
  firstSeen: string;
}

/** A `match_review` row: the record's firm, the `candidate` it may be the same as, and how the pair scored. */
export interface ReviewDraft {
  source: FirmRecordSource;
  key: string;
  firm: FirmRef;
  candidate: FirmRef;
  score: number;
  reason: MatchReviewReason;
  evidence: LinkEvidence & { parts: LinkScoreParts };
}

/** What a linking run writes, each list in the order the engine decided it. */
export interface LinkPlan {
  newFirms: NewFirm[];
  links: RecordLink[];
  feis: FeiAssignment[];
  reviews: ReviewDraft[];
}
