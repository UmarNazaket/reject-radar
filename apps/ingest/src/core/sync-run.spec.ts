import { commodity, notice, prepareTestDatabase, sourceSyncRun } from '@rejectradar/db';
import { count, desc, eq } from 'drizzle-orm';
import { openDb } from './db';
import { upsertNotices } from './notices';
import { SIZE_LIMIT_BYTES, SizeLimitError } from './size-check';
import { lastSucceededRun, runSync } from './sync-run';

describe('runSync', () => {
  let handle: ReturnType<typeof openDb>;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_core'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.delete(notice);
    await handle.db.delete(sourceSyncRun);
    await handle.db.insert(commodity).values({ id: 1, slug: 'apples', name: 'Apples' }).onConflictDoNothing();
  });

  const lastRun = async () => {
    const [row] = await handle.db.select().from(sourceSyncRun).orderBy(desc(sourceSyncRun.id)).limit(1);
    return row;
  };

  it('records a succeeded run with counts', async () => {
    const result = await runSync(handle.db, 'uk_bn', async (ctx) => {
      ctx.counts.rowsRead = 3;
      ctx.counts.eventsEmitted = 1;
      ctx.setOrigin('https://x', 'abc');
    });

    const row = await lastRun();
    expect(result).toMatchObject({ runId: row.id, status: 'succeeded', rowsRead: 3, eventsEmitted: 1 });
    expect(row).toMatchObject({
      source: 'uk_bn',
      status: 'succeeded',
      rowsRead: 3,
      rowsInserted: 0,
      eventsEmitted: 1,
      origin: 'https://x',
      contentSha256: 'abc',
      error: null,
    });
    expect(row.finishedAt).not.toBeNull();
  });

  it('leaves live tables unchanged when the work throws inside the transaction', async () => {
    await expect(
      runSync(handle.db, 'rasff', async () => {
        await handle.db.transaction(async (tx) => {
          await upsertNotices(tx, [
            {
              source: 'rasff',
              sourceKey: 'k1',
              noticeType: 'rasff_alert',
              noticeOn: '2026-01-01',
              originCountry: 'ES',
              commodityId: 1,
              hazardIds: [],
              productText: 'p',
              firmName: null,
              title: 't',
              url: null,
            },
          ]);
          throw new Error('boom');
        });
      }),
    ).rejects.toThrow('boom');

    const [{ n }] = await handle.db.select({ n: count() }).from(notice);
    expect(n).toBe(0);
    const row = await lastRun();
    expect(row.status).toBe('failed');
    expect(row.error).toContain('boom');
    expect(row.finishedAt).not.toBeNull();
  });

  it('aborts before any work at the size limit', async () => {
    const work = jest.fn();
    await expect(runSync(handle.db, 'eu_mrl', work, { sizeLimitBytes: 1 })).rejects.toBeInstanceOf(SizeLimitError);
    expect(work).not.toHaveBeenCalled();
    const row = await lastRun();
    expect(row.status).toBe('failed');
    expect(row.error).toContain('limit');
  });

  it('uses a 900 MB default limit', () => {
    expect(SIZE_LIMIT_BYTES).toBe(943718400);
    expect(new SizeLimitError(1, SIZE_LIMIT_BYTES).message).toContain('900 MB');
  });

  it('truncates long errors to 2000 characters', async () => {
    await expect(
      runSync(handle.db, 'au_ifis', async () => {
        throw new Error('x'.repeat(5000));
      }),
    ).rejects.toThrow();
    const row = await lastRun();
    expect(row.error).toHaveLength(2000);
  });

  it('finds the last succeeded run per source', async () => {
    expect(await lastSucceededRun(handle.db, 'uk_bn')).toBeNull();
    await runSync(handle.db, 'uk_bn', async () => undefined);
    await expect(runSync(handle.db, 'uk_bn', () => Promise.reject(new Error('no')))).rejects.toThrow();
    const second = await runSync(handle.db, 'uk_bn', async () => undefined);
    const found = await lastSucceededRun(handle.db, 'uk_bn');
    expect(found?.id).toBe(second.runId);
    expect(found?.startedAt).toBeInstanceOf(Date);
    expect(await lastSucceededRun(handle.db, 'rasff')).toBeNull();
    const rows = await handle.db.select().from(sourceSyncRun).where(eq(sourceSyncRun.source, 'uk_bn'));
    expect(rows).toHaveLength(3);
  });
});
