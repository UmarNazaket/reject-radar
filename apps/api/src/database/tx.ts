import type { Database } from '@rejectradar/db';

/** The handle `db.transaction(async (tx) => …)` passes in; services take it so several writes share one commit. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
