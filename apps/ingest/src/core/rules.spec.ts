import { commodityRule, prepareTestDatabase } from '@rejectradar/db';
import { classifyCommodity, loadRuleSet } from '@rejectradar/taxonomy';
import { sql } from 'drizzle-orm';
import { openDb } from './db';

describe('loadRuleSet', () => {
  let handle: ReturnType<typeof openDb>;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_rules'));
  });
  afterAll(async () => {
    await handle.close();
  });

  const countOf = async (table: string): Promise<number> => {
    const result = await handle.db.execute<{ n: string }>(sql.raw(`select count(*) as n from ${table}`));
    return Number(result.rows[0]?.n);
  };

  it('seeds the taxonomy through the migrations', async () => {
    expect(await countOf('commodity')).toBe(38);
    expect(await countOf('hazard')).toBe(21);
    expect(await countOf('commodity_rule')).toBeGreaterThan(0);
    expect(await countOf('hazard_rule')).toBeGreaterThan(0);
  });

  it('loads rules that classify a notice', async () => {
    const rules = await loadRuleSet(handle.db);
    expect(classifyCommodity(rules, 'fda_refusal', { product_desc: 'SESAME SEEDS' })).toBe(301);
  });

  it('orders by priority, then id', async () => {
    const { commodity, hazard } = await loadRuleSet(handle.db);
    for (const list of [commodity, hazard]) {
      for (let i = 1; i < list.length; i++) {
        const [prev, next] = [list[i - 1], list[i]];
        expect(prev.priority < next.priority || (prev.priority === next.priority && prev.id < next.id)).toBe(true);
      }
    }
  });

  it('picks up a rule inserted at runtime in a fresh load', async () => {
    const before = await loadRuleSet(handle.db);
    expect(classifyCommodity(before, 'fda_refusal', { product_desc: 'moringa leaf' })).toBe(1800);

    await handle.db.insert(commodityRule).values({
      source: '*',
      field: 'product_desc',
      matchType: 'keyword',
      pattern: 'moringa',
      commodityId: 205,
      priority: 5,
    });

    const after = await loadRuleSet(handle.db);
    expect(classifyCommodity(after, 'fda_refusal', { product_desc: 'moringa leaf' })).toBe(205);
    expect(classifyCommodity(before, 'fda_refusal', { product_desc: 'moringa leaf' })).toBe(1800);
  });
});
