import {
  auFailingFood,
  changeEvent,
  createDb,
  createPool,
  type Database,
  fdaRefusal,
  firm,
  firmAlias,
  firmFei,
  importAlert,
  importAlertListing,
  matchReview,
  notice,
  prepareTestDatabase,
} from '@rejectradar/db';
import { sql } from 'drizzle-orm';
import { linkEntities } from './link-entities';
import { lockFirms } from './lock';
import { insertRefusal } from './testing';
import type { Tx } from './types';

const TODAY = '2026-10-22';

/** Polls `condition` every 10 ms and throws `message` when it still fails after 10 s. */
async function waitFor(condition: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the firm lock', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Database;

  beforeAll(async () => {
    pool = createPool(await prepareTestDatabase('entities_lock'));
    db = createDb(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    // Rows that reference a firm (or a notice) go first.
    for (const table of [
      matchReview,
      changeEvent,
      notice,
      firmFei,
      firmAlias,
      fdaRefusal,
      importAlertListing,
      importAlert,
      auFailingFood,
      firm,
    ]) {
      await db.delete(table);
    }
  });

  /** How many sessions of this database are waiting for an advisory lock. */
  async function lockWaiters(): Promise<number> {
    const { rows } = await db.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting
      from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())`);
    return rows[0].waiting;
  }

  /**
   * Starts `write` while another transaction, on another connection, holds the firm lock and has written with `hold`.
   * `write` must wait for the lock instead of finishing. The holder then commits, and `write`'s result is returned.
   */
  async function writeWhileLocked<T>(hold: (tx: Tx) => Promise<unknown>, write: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await lockFirms(tx);
      await hold(tx);
      locked();
      await released;
    });
    try {
      await Promise.race([isLocked, holder]);
      let finished = false;
      const writing = write().finally(() => {
        finished = true;
      });
      await waitFor(async () => (await lockWaiters()) > 0, 'The write never waited for the firm lock');
      expect(finished).toBe(false);

      release();
      await holder;
      return await writing;
    } finally {
      release();
      await holder;
    }
  }

  it('linkEntities waits for the lock, then links what the holder committed', async () => {
    const result = await writeWhileLocked(
      (tx) => insertRefusal(tx, { firmName: 'Gurudev Spices', countryCode: 'IN' }),
      () => linkEntities(db, { today: TODAY }),
    );

    // The run loaded once the holder had committed, so it saw the holder's refusal.
    expect(result).toMatchObject({ records: { fda_refusal: 1 }, firmsCreated: 1, linked: 1 });
  });
});
