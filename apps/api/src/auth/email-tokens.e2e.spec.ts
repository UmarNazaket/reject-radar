import { appUser, type Database } from '@rejectradar/db';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '../common/ids';
import { DB } from '../database/database.module';
import { startTestApp, type TestApp } from '../testing/test-app';
import { EmailTokensService } from './email-tokens.service';

describe('EmailTokensService', () => {
  let t: TestApp;
  let tokens: EmailTokensService;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    t = await startTestApp('api_email_tokens');
    tokens = t.app.get(EmailTokensService);
    db = t.app.get<Database>(DB);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.db.execute(sql`truncate app_user, org cascade`);
    userId = uuidv7();
    await db.insert(appUser).values({ id: userId, email: 'tokens@example.com', passwordHash: 'x', name: 'Token User', locale: 'en' });
  });

  const unused = async () => {
    const result = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from email_token where used_at is null`);
    return result.rows[0].n;
  };

  it('parallel issues for one user leave exactly one unused token', async () => {
    for (let round = 0; round < 5; round++) {
      const raws = await Promise.all(Array.from({ length: 6 }, () => db.transaction((tx) => tokens.issue(tx, userId, 'reset'))));
      expect(new Set(raws).size).toBe(6);
      expect(await unused()).toBe(1);
    }
  });

  it('sets the expiry from the database clock: 1 hour for reset, 24 hours for verify', async () => {
    await db.transaction((tx) => tokens.issue(tx, userId, 'reset'));
    await db.transaction((tx) => tokens.issue(tx, userId, 'verify'));
    const rows = await t.db.execute<{ purpose: string; seconds: number }>(
      sql`select purpose, round(extract(epoch from (expires_at - now())))::int as seconds from email_token`,
    );
    const byPurpose = Object.fromEntries(rows.rows.map((row) => [row.purpose, row.seconds]));
    expect(byPurpose['reset']).toBeGreaterThan(3590);
    expect(byPurpose['reset']).toBeLessThanOrEqual(3600);
    expect(byPurpose['verify']).toBeGreaterThan(86_390);
    expect(byPurpose['verify']).toBeLessThanOrEqual(86_400);
  });
});
