import { alertEmail, bulkJob, bulkJobRow, type Database, emailDelivery, emailToken, invite, paddleEvent, refreshToken } from '@rejectradar/db';
import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';

const DAY_MS = 86_400_000;

/** Retention windows (spec §6.3, §7.2; P6-D11). */
export const RETENTION_DAYS = {
  /** `bulk_job_row` rows go this long after their job finished. */
  bulkRows: 30,
  /** `paddle_event.payload`, `email_delivery` and `alert_email` are kept this long. */
  logs: 90,
  /** Used or expired tokens and invites are kept this long after the later of the two moments. */
  tokens: 30,
} as const;

/** How many rows each rule removed or cleared. */
export interface PurgeCounts {
  bulkRows: number;
  paddlePayloads: number;
  emailDeliveries: number;
  alertEmails: number;
  emailTokens: number;
  refreshTokens: number;
  invites: number;
}

const before = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/**
 * Applies the retention rules (P6-D11), each in its own transaction, and counts what it touched. Cutoffs are computed
 * from `now` and passed as parameters, never read from the database clock, so a run is repeatable. It is idempotent: a
 * second run with the same `now` returns zeros. `alert` rows are deliberately not purged (the owner decides at P11).
 */
export async function purge(db: Database, now: Date = new Date()): Promise<PurgeCounts> {
  const bulkCutoff = before(now, RETENTION_DAYS.bulkRows);
  const logCutoff = before(now, RETENTION_DAYS.logs);
  const tokenCutoff = before(now, RETENTION_DAYS.tokens);

  const bulkRows = await db.transaction(async (tx) => {
    // A running or queued job has no finished_at, so its rows stay whatever their age.
    const finished = tx.select({ id: bulkJob.id }).from(bulkJob).where(lt(bulkJob.finishedAt, bulkCutoff));
    return (await tx.delete(bulkJobRow).where(inArray(bulkJobRow.jobId, finished))).rowCount ?? 0;
  });

  const paddlePayloads = await db.transaction(
    async (tx) =>
      (await tx.update(paddleEvent).set({ payload: null }).where(and(lt(paddleEvent.receivedAt, logCutoff), isNotNull(paddleEvent.payload)))).rowCount ?? 0,
  );

  const emailDeliveries = await db.transaction(async (tx) => (await tx.delete(emailDelivery).where(lt(emailDelivery.createdAt, logCutoff))).rowCount ?? 0);

  const alertEmails = await db.transaction(async (tx) => (await tx.delete(alertEmail).where(lt(alertEmail.createdAt, logCutoff))).rowCount ?? 0);

  // `greatest` ignores nulls: for a token never used it is the expiry, otherwise the later of use and expiry.
  const emailTokens = await db.transaction(
    async (tx) => (await tx.delete(emailToken).where(sql`greatest(${emailToken.expiresAt}, ${emailToken.usedAt}) < ${tokenCutoff}`)).rowCount ?? 0,
  );

  const refreshTokens = await db.transaction(
    async (tx) => (await tx.delete(refreshToken).where(sql`greatest(${refreshToken.expiresAt}, ${refreshToken.revokedAt}) < ${tokenCutoff}`)).rowCount ?? 0,
  );

  const invites = await db.transaction(
    async (tx) => (await tx.delete(invite).where(sql`greatest(${invite.expiresAt}, ${invite.acceptedAt}) < ${tokenCutoff}`)).rowCount ?? 0,
  );

  return { bulkRows, paddlePayloads, emailDeliveries, alertEmails, emailTokens, refreshTokens, invites };
}
