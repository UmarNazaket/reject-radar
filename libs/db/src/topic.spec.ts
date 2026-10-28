import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDb, createPool, type Database } from './client';
import { notice } from './schema';
import { commodityWithin, topicFilter, topicMatchesItem } from './topic';
import { prepareTestDatabase } from './testing';

let pool: Pool;
let db: Database;
let seq = 0;

async function addNotice(fields: { originCountry?: string; commodityId?: number | null; destination?: string; hazardIds?: number[] }): Promise<number> {
  seq += 1;
  const [row] = await db
    .insert(notice)
    .values({
      source: 'rasff',
      sourceKey: `topic-${seq}`,
      destination: fields.destination ?? 'EU',
      noticeType: 'rasff_alert',
      noticeOn: '2026-10-01',
      originCountry: fields.originCountry ?? 'PK',
      commodityId: fields.commodityId ?? null,
      hazardIds: fields.hazardIds ?? [],
    })
    .returning({ id: notice.id });
  return row.id;
}

describe('shared topic matching (spec §7.2, §11)', () => {
  beforeAll(async () => {
    pool = createPool(await prepareTestDatabase('db_topic'));
    db = createDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('commodityWithin includes descendants', async () => {
    const ids = await Promise.all([201, 202, 101, null].map((commodityId) => addNotice({ commodityId, originCountry: 'CW' })));
    const rows = await db
      .select({ commodityId: notice.commodityId })
      .from(notice)
      .where(and(eq(notice.originCountry, 'CW'), commodityWithin(notice.commodityId, 200)));
    expect(ids).toHaveLength(4);
    expect(rows.map((r) => r.commodityId).sort()).toEqual([201, 202]);
  });

  it('topicFilter combines the optional parts', async () => {
    const match = await addNotice({ originCountry: 'PK', commodityId: 201, destination: 'EU', hazardIds: [300, 100] });
    await addNotice({ originCountry: 'IN', commodityId: 201, destination: 'EU', hazardIds: [300, 100] });
    await addNotice({ originCountry: 'PK', commodityId: 201, destination: 'US', hazardIds: [300, 100] });
    await addNotice({ originCountry: 'PK', commodityId: 201, destination: 'EU', hazardIds: [100] });
    const rows = await db
      .select({ id: notice.id })
      .from(notice)
      .where(
        topicFilter(
          { originCountry: notice.originCountry, commodityId: notice.commodityId, destination: notice.destination, hazardIds: notice.hazardIds },
          { originCountry: 'PK', commodityId: 200, destination: 'EU', hazardId: 300 },
        ),
      );
    expect(rows.map((r) => r.id)).toEqual([match]);
  });

  it('topicFilter with only an origin matches every notice from it', async () => {
    await addNotice({ originCountry: 'ZZ', commodityId: null, destination: 'UK' });
    await addNotice({ originCountry: 'ZZ', commodityId: 101, destination: 'AU', hazardIds: [100] });
    const rows = await db
      .select({ id: notice.id })
      .from(notice)
      .where(
        topicFilter(
          { originCountry: notice.originCountry, commodityId: notice.commodityId, destination: notice.destination, hazardIds: notice.hazardIds },
          { originCountry: 'ZZ', commodityId: null, destination: null, hazardId: null },
        ),
      );
    expect(rows).toHaveLength(2);
  });

  /** Does a one-row event match a one-row watchlist item? Both are `values` lists, as in the alert matcher. */
  async function matches(
    item: { origin: string; commodity: number | null; destination: string | null; hazard: number | null },
    event: { origin: string; commodity: number | null; destination: string; hazards: number[] },
  ): Promise<boolean> {
    const result = await db.execute<{ ok: boolean }>(sql`
      select true as ok
      from (values (${event.origin}::text, ${event.commodity}::int, ${event.destination}::text, ${sql.raw(`array[${event.hazards.join(',')}]::int[]`)})) as e(origin_country, commodity_id, destination, hazard_ids)
      join (values (${item.origin}::text, ${item.commodity}::int, ${item.destination}::text, ${item.hazard}::int)) as i(origin_country, commodity_id, destination, hazard_id)
        on ${topicMatchesItem(
          { originCountry: sql`e.origin_country`, commodityId: sql`e.commodity_id`, destination: sql`e.destination`, hazardIds: sql`e.hazard_ids` },
          { originCountry: sql`i.origin_country`, commodityId: sql`i.commodity_id`, destination: sql`i.destination`, hazardId: sql`i.hazard_id` },
          sql`(select ancestor_ids from commodity where id = e.commodity_id)`,
        )}
    `);
    return result.rows.length === 1;
  }

  it('topicMatchesItem follows §11', async () => {
    const event = { origin: 'PK', commodity: 201, destination: 'EU', hazards: [300] };
    expect(await matches({ origin: 'PK', commodity: 200, destination: null, hazard: null }, event)).toBe(true);
    expect(await matches({ origin: 'PK', commodity: 201, destination: null, hazard: null }, event)).toBe(true);
    expect(await matches({ origin: 'PK', commodity: 202, destination: null, hazard: null }, event)).toBe(false);
    expect(await matches({ origin: 'PK', commodity: 201, destination: 'US', hazard: null }, event)).toBe(false);
    expect(await matches({ origin: 'PK', commodity: null, destination: 'EU', hazard: 300 }, event)).toBe(true);
    expect(await matches({ origin: 'PK', commodity: null, destination: null, hazard: 100 }, event)).toBe(false);
    expect(await matches({ origin: 'IN', commodity: null, destination: null, hazard: null }, event)).toBe(false);
    // A broader event does not match a narrower item.
    expect(await matches({ origin: 'PK', commodity: 201, destination: null, hazard: null }, { ...event, commodity: 200 })).toBe(false);
    // An item with no commodity matches an event with none.
    expect(await matches({ origin: 'PK', commodity: null, destination: null, hazard: null }, { ...event, commodity: null, hazards: [] })).toBe(true);
  });
});
