import { changeEvent, commodity, notice, prepareTestDatabase } from '@rejectradar/db';
import { count, eq } from 'drizzle-orm';
import { openDb } from './db';
import { insertEvents, upsertNotices, type NoticeInput } from './notices';

describe('notice and event writers', () => {
  let handle: ReturnType<typeof openDb>;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_notices'));
  });
  afterAll(async () => {
    await handle.close();
  });
  beforeEach(async () => {
    await handle.db.delete(changeEvent);
    await handle.db.delete(notice);
    await handle.db.delete(commodity);
    await handle.db.insert(commodity).values({ id: 1, slug: 'apples', name: 'Apples' });
  });

  const make = (key: string, overrides: Partial<NoticeInput> = {}): NoticeInput => ({
    source: 'uk_bn',
    sourceKey: key,
    noticeType: 'uk_border_notification',
    noticeOn: '2026-02-03',
    originCountry: 'TR',
    commodityId: 1,
    hazardIds: [2, 3],
    productText: 'dried apricots',
    firmName: 'Acme',
    title: 'Original title',
    url: 'https://example.com/a',
    ...overrides,
  });
  const upsert = (rows: NoticeInput[]) => handle.db.transaction((tx) => upsertNotices(tx, rows));

  it('inserts new notices and reports inserted=true', async () => {
    const result = await upsert([make('a'), make('b')]);
    expect([...result.keys()].sort()).toEqual(['a', 'b']);
    expect(result.get('a')).toMatchObject({ inserted: true });
    expect(typeof result.get('a')?.id).toBe('number');
    const [row] = await handle.db.select().from(notice).where(eq(notice.sourceKey, 'a'));
    expect(row).toMatchObject({ destination: 'UK', hazardIds: [2, 3], title: 'Original title', firmId: null });
  });

  it('reports nothing for an unchanged re-upsert', async () => {
    await upsert([make('a'), make('b')]);
    const again = await upsert([make('a'), make('b')]);
    expect(again.size).toBe(0);
  });

  it('updates a changed notice and reports inserted=false', async () => {
    const first = await upsert([make('a'), make('b')]);
    const second = await upsert([make('a', { title: 'New title' }), make('b')]);
    expect([...second.keys()]).toEqual(['a']);
    expect(second.get('a')).toEqual({ id: first.get('a')?.id, inserted: false });
    const [row] = await handle.db.select().from(notice).where(eq(notice.sourceKey, 'a'));
    expect(row.title).toBe('New title');
  });

  it('treats a changed hazard list as a change', async () => {
    await upsert([make('a')]);
    const changed = await upsert([make('a', { hazardIds: [2] })]);
    expect(changed.get('a')?.inserted).toBe(false);
  });

  it('batches large inputs', async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => make(`k${i}`));
    const result = await upsert(rows);
    expect(result.size).toBe(1201);
    const [{ n }] = await handle.db.select({ n: count() }).from(notice);
    expect(n).toBe(1201);
  });

  it('fills severity and destination for events', async () => {
    const inserted = await handle.db.transaction((tx) =>
      insertEvents(tx, [
        {
          source: 'rasff',
          sourceKey: 'r1',
          kind: 'rasff_notification',
          occurredOn: '2026-03-04',
          requiresFirm: false,
          originCountry: 'EG',
          commodityId: null,
          hazardIds: [5],
          noticeId: null,
          payload: { a: 1 },
        },
      ]),
    );
    expect(inserted).toBe(1);
    const [row] = await handle.db.select().from(changeEvent);
    expect(row).toMatchObject({
      source: 'rasff',
      kind: 'rasff_notification',
      severity: 'normal',
      destination: 'EU',
      firmId: null,
      hazardIds: [5],
      payload: { a: 1 },
    });
  });

  it('returns 0 for no events', async () => {
    expect(await handle.db.transaction((tx) => insertEvents(tx, []))).toBe(0);
  });
});
