import { EMAIL_CAP_TIERS, type EmailKind } from '@rejectradar/contracts';
import { createDb, createPool, type Database, prepareTestDatabase, uuidv7 } from '@rejectradar/db';
import { EmailCapReachedError, Mailer } from './mailer';
import type { MailMessage, MailTransport } from './transports';

const CONTENT = { subject: 'Subject', html: '<p>Hello</p>', text: 'Hello' };
const START_OF_TODAY = "date_trunc('day', now() at time zone 'utc') at time zone 'utc'";

class FakeTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  private failure: Error | null = null;

  failNext(error: Error): void {
    this.failure = error;
  }

  async send(message: MailMessage): Promise<{ providerId: string | null }> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    this.sent.push(message);
    return { providerId: `fake-${this.sent.length}` };
  }
}

describe('Mailer', () => {
  let pool: ReturnType<typeof createPool>;
  let db: Database;
  let mailer: Mailer;
  const transport = new FakeTransport();
  const errors: { kind: EmailKind; deliveryId: string; err: unknown; stage: string }[] = [];

  beforeAll(async () => {
    pool = createPool(await prepareTestDatabase('mail'));
    db = createDb(pool);
    mailer = new Mailer({ db, transport, from: 'RejectRadar <test@rejectradar.test>', onError: (info) => errors.push(info) });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from email_delivery');
    transport.sent.length = 0;
    errors.length = 0;
  });

  /** Inserts `count` rows of today (from midnight UTC on) or of yesterday (the last second before it). */
  async function seed(count: number, when: 'today' | 'yesterday', status = 'sent'): Promise<void> {
    const createdAt = when === 'today' ? START_OF_TODAY : `${START_OF_TODAY} - interval '1 second'`;
    for (let i = 0; i < count; i++) {
      await pool.query(
        `insert into email_delivery (id, to_email, kind, status, created_at) values ($1, 'seed@example.com', 'verify', $2, ${createdAt})`,
        [uuidv7(), status],
      );
    }
  }

  const send = (kind: EmailKind, to = 'sara@example.com') => mailer.send({ kind, to, userId: null, content: CONTENT });
  const rows = async () =>
    (await pool.query('select kind, status, provider_id, error, to_email, user_id from email_delivery order by created_at')).rows;

  it('records a sent email', async () => {
    await expect(send('verify')).resolves.toBe('sent');
    expect(transport.sent).toEqual([expect.objectContaining({ to: 'sara@example.com', ...CONTENT, from: 'RejectRadar <test@rejectradar.test>' })]);
    expect(await rows()).toEqual([
      { kind: 'verify', status: 'sent', provider_id: 'fake-1', error: null, to_email: 'sara@example.com', user_id: null },
    ]);
  });

  it('pauses an instant alert at 70', async () => {
    await seed(70, 'today');
    await seed(5, 'yesterday');
    await expect(send('instant_alert')).resolves.toBe('paused');
    expect(transport.sent).toHaveLength(0);
    const { rows: paused } = await pool.query("select kind from email_delivery where status = 'paused'");
    expect(paused).toEqual([{ kind: 'instant_alert' }]);
  });

  it('sends an instant alert at 69', async () => {
    await seed(EMAIL_CAP_TIERS.instant - 1, 'today');
    await expect(send('instant_alert')).resolves.toBe('sent');
  });

  it('pauses a digest at 90 but not at 89', async () => {
    await seed(89, 'today');
    await expect(send('digest')).resolves.toBe('sent');
    await expect(send('digest')).resolves.toBe('paused');
    expect(transport.sent).toHaveLength(1);
  });

  it('still sends account emails when instants and digests are paused', async () => {
    await seed(95, 'today');
    await expect(send('digest')).resolves.toBe('paused');
    await expect(send('verify')).resolves.toBe('sent');
  });

  it('refuses an account email at 100', async () => {
    await seed(99, 'today');
    await expect(mailer.assertCapacity('verify')).resolves.toBeUndefined();
    await seed(1, 'today');
    await expect(mailer.assertCapacity('verify')).rejects.toBeInstanceOf(EmailCapReachedError);
  });

  it('records a paused row and then refuses when an account email is sent at 100', async () => {
    await seed(100, 'today');
    await expect(send('reset')).rejects.toBeInstanceOf(EmailCapReachedError);
    expect(transport.sent).toHaveLength(0);
    const { rows: paused } = await pool.query("select kind from email_delivery where status = 'paused'");
    expect(paused).toEqual([{ kind: 'reset' }]);
  });

  it('does not count paused or failed rows', async () => {
    await seed(60, 'today');
    await seed(30, 'today', 'paused');
    await seed(30, 'today', 'failed');
    await expect(send('instant_alert')).resolves.toBe('sent');
  });

  it('counts rows that are still sending', async () => {
    await seed(70, 'today', 'sending');
    await expect(send('instant_alert')).resolves.toBe('paused');
  });

  it('records a transport failure and reports it with the kind and row id', async () => {
    const failure = new Error('smtp down');
    transport.failNext(failure);
    await expect(send('verify')).resolves.toBe('failed');
    expect(await rows()).toEqual([expect.objectContaining({ status: 'failed', error: 'smtp down', provider_id: null })]);
    const { rows: failed } = await pool.query("select id from email_delivery where status = 'failed'");
    expect(errors).toEqual([{ kind: 'verify', deliveryId: failed[0].id, err: failure, stage: 'send' }]);
  });

  it('cuts a long error to 500 characters', async () => {
    transport.failNext(new Error('x'.repeat(2000)));
    await send('verify');
    const { rows: failed } = await pool.query("select error from email_delivery where status = 'failed'");
    expect(failed[0].error).toHaveLength(500);
  });

  it('works without an error callback', async () => {
    const quiet = new Mailer({ db, transport, from: 'a@rejectradar.test' });
    transport.failNext(new Error('smtp down'));
    await expect(quiet.send({ kind: 'verify', to: 'a@example.com', userId: null, content: CONTENT })).resolves.toBe('failed');
  });

  it('stores the address as given and keeps the user id', async () => {
    const { rows: users } = await pool.query(
      "insert into app_user (id, email, password_hash, name) values ($1, 'u@example.com', 'x', 'U') returning id",
      [uuidv7()],
    );
    await mailer.send({ kind: 'invite', to: 'Mixed.Case@Example.com', userId: users[0].id, content: CONTENT });
    expect(await rows()).toEqual([expect.objectContaining({ to_email: 'Mixed.Case@Example.com', user_id: users[0].id })]);
  });

  it('never sends more than the cap in parallel', async () => {
    await seed(98, 'today');
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => send('verify', `user${i}@example.com`)));
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === 'sent')).toHaveLength(2);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(8);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(EmailCapReachedError);
    expect(transport.sent).toHaveLength(2);
    const { rows: counted } = await pool.query(
      `select count(*)::int as n from email_delivery where status in ('sending', 'sent') and created_at >= ${START_OF_TODAY}`,
    );
    expect(counted[0].n).toBe(100);
  });
});
