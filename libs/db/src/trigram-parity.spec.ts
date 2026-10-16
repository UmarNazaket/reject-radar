import { trigramSimilarity } from '@rejectradar/matching';
import { Client } from 'pg';
import { prepareTestDatabase } from './testing';

const PAIRS: [string, string][] = [
  ['word', 'two words'],
  ['al rahman rice mills', 'al rahman rice'],
  ['haji bashir ahmad and sons', 'haji bashir ahmad sons'],
  ['qingdao haida foodstuffs', 'qingdao haida food stuffs'],
  ['thuc pham duc phat', 'thuc pham duc phat'],
  ['123 rice mills', '123 rice mill'],
];

describe('trigramSimilarity matches PostgreSQL similarity()', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: await prepareTestDatabase('db') });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it.each(PAIRS)('%p vs %p', async (a, b) => {
    const { rows } = await client.query<{ s: number }>('select similarity($1, $2)::float8 as s', [a, b]);
    expect(trigramSimilarity(a, b)).toBeCloseTo(rows[0].s, 4);
  });
});
