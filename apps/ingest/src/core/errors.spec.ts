import { prepareTestDatabase, rasffNotification } from '@rejectradar/db';
import { inArray, sql } from 'drizzle-orm';
import { openDb } from './db';
import { describeError } from './errors';

describe('describeError', () => {
  it('shows the Postgres code and message of a failed query, without its params', async () => {
    const { db, close } = openDb(await prepareTestDatabase('ingest_errors'));
    try {
      // A database that never got migration 0010, as staging was.
      await db.execute(sql`alter table rasff_notification drop column details_failures`);
      const error = await db
        .select()
        .from(rasffNotification)
        .where(inArray(rasffNotification.reference, ['2026.9604']))
        .then(() => null, (e: Error) => e);

      const described = describeError(error as Error);
      expect(described).toMatch(/^Failed query: select .* from "rasff_notification" where .* in \(\$1\)$/m);
      expect(described).toMatch(/^Caused by: \[42703\] column "details_failures" does not exist$/m);
      expect(described).not.toContain('2026.9604');
    } finally {
      await close();
    }
  });

  it('stops following a cause chain that loops', () => {
    const error = new Error('outer');
    (error as Error & { cause?: unknown }).cause = error;
    expect(describeError(error).split('\n')).toHaveLength(6);
  });
});
