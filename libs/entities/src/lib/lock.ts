import { sql } from 'drizzle-orm';
import type { Tx } from './types';

/** The advisory-lock key of the firm writers, linkEntities, mergeFirms and splitFirm (ruling R12): "FIRM" in ASCII. */
export const FIRM_LOCK_KEY = 0x4649524d;

/**
 * Waits for the firm lock and holds it until `tx` ends, so that the firm writers run one at a time: a merge or a split
 * never commits between a link run's load and its apply. The lock belongs to the transaction, which releases it on
 * commit or rollback; that keeps it safe behind Neon's transaction-mode pooler, where a session lock would stay on a
 * server connection that other clients go on to use.
 */
export async function lockFirms(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${FIRM_LOCK_KEY}::bigint)`);
}
