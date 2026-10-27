import { appUser, type Database } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
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

  it('a parallel issue and consume for the same user and purpose both complete, without a deadlock', async () => {
    // consume() is followed by an app_user update, as verify-email and reset-password do. The sleeps make the bad
    // interleaving certain under the old lock order: consume locks the token, issue then locks the user and waits on
    // the token, and consume's user update would wait on issue (40P01).
    const consumeThenTouchUser = (raw: string, pause: number) =>
      db.transaction(async (tx) => {
        const { userId: consumed } = await tokens.consume(tx, raw, 'reset');
        await tx.execute(sql`select pg_sleep(${pause})`);
        await tx.update(appUser).set({ failedLogins: 0 }).where(eq(appUser.id, consumed));
      });
    const issueAfter = (pause: number) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select pg_sleep(${pause})`);
        return tokens.issue(tx, userId, 'reset');
      });

    /** `ok`, the AppError code, or the Postgres SQLSTATE (40P01 is a deadlock) of a settled transaction. */
    const outcome = (result: PromiseSettledResult<unknown>): string => {
      if (result.status === 'fulfilled') return 'ok';
      const error = result.reason as { code?: string; cause?: { code?: string }; message?: string };
      return error instanceof AppError ? error.code : (error.cause?.code ?? error.code ?? String(error.message));
    };

    for (let round = 0; round < 6; round++) {
      const raw = await db.transaction((tx) => tokens.issue(tx, userId, 'reset'));
      const staggered = round % 2 === 0;
      const results = await Promise.allSettled([consumeThenTouchUser(raw, staggered ? 0.2 : 0), issueAfter(staggered ? 0.05 : 0)]);
      // issue always succeeds; consume either spends the link or, if issue went first, finds it replaced
      expect(outcome(results[1])).toBe('ok');
      expect(['ok', 'INVALID_TOKEN']).toContain(outcome(results[0]));
      expect(await unused()).toBe(1);
    }
  });

  it('consume refuses a missing, a used and an expired token with the same INVALID_TOKEN', async () => {
    const codeOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        return error instanceof AppError ? `${error.getStatus()} ${error.code} ${error.message}` : String(error);
      }
      return 'no error';
    };
    const expected = '400 INVALID_TOKEN This link is invalid or has expired.';
    expect(await codeOf(() => db.transaction((tx) => tokens.consume(tx, 'not-a-real-token', 'reset')))).toBe(expected);

    const used = await db.transaction((tx) => tokens.issue(tx, userId, 'reset'));
    await db.transaction((tx) => tokens.consume(tx, used, 'reset'));
    expect(await codeOf(() => db.transaction((tx) => tokens.consume(tx, used, 'reset')))).toBe(expected);

    const expired = await db.transaction((tx) => tokens.issue(tx, userId, 'verify'));
    await t.db.execute(sql`update email_token set expires_at = now() - interval '1 second' where purpose = 'verify'`);
    expect(await codeOf(() => db.transaction((tx) => tokens.consume(tx, expired, 'verify')))).toBe(expected);

    // the right token for the wrong purpose is also invalid
    const reset = await db.transaction((tx) => tokens.issue(tx, userId, 'reset'));
    expect(await codeOf(() => db.transaction((tx) => tokens.consume(tx, reset, 'verify')))).toBe(expected);
  });
});
