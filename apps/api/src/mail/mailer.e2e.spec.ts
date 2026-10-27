import { type INestApplication, Logger } from '@nestjs/common';
import { EMAIL_CAP_TIERS, type EmailKind } from '@rejectradar/contracts';
import { prepareTestDatabase } from '@rejectradar/db';
import { Client } from 'pg';
import { createApp } from '../bootstrap';
import { uuidv7 } from '../common/ids';
import { FakeTransport, testEnv } from '../testing/test-app';
import { MailerService } from './mailer.service';

const CONTENT = { subject: 'Subject', html: '<p>Hello</p>', text: 'Hello' };
const START_OF_TODAY = "date_trunc('day', now() at time zone 'utc') at time zone 'utc'";

describe('MailerService', () => {
  let app: INestApplication;
  let client: Client;
  let mailer: MailerService;
  let transport: FakeTransport;

  beforeAll(async () => {
    const url = await prepareTestDatabase('api_mailer');
    transport = new FakeTransport();
    app = await createApp(testEnv(url), { mailTransport: transport });
    await app.init();
    mailer = app.get(MailerService);
    client = new Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(async () => {
    await client.query('delete from email_delivery');
    transport.sent.length = 0;
  });

  /** Inserts `count` rows of today (from midnight UTC on) or of yesterday (the last second before it). */
  async function seed(count: number, when: 'today' | 'yesterday', status = 'sent'): Promise<void> {
    const createdAt = when === 'today' ? START_OF_TODAY : `${START_OF_TODAY} - interval '1 second'`;
    for (let i = 0; i < count; i++) {
      await client.query(
        `insert into email_delivery (id, to_email, kind, status, created_at) values ($1, 'seed@example.com', 'verify', $2, ${createdAt})`,
        [uuidv7(), status],
      );
    }
  }

  const send = (kind: EmailKind, to = 'sara@example.com') => mailer.send({ kind, to, userId: null, content: CONTENT });
  const rows = async () =>
    (await client.query('select kind, status, provider_id, error, to_email, user_id from email_delivery order by created_at')).rows;

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
    const { rows: paused } = await client.query("select kind from email_delivery where status = 'paused'");
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
    await expect(mailer.assertCapacity('verify')).rejects.toMatchObject({ code: 'EMAIL_CAP_REACHED', status: 503 });
    await expect(mailer.assertCapacity('verify')).rejects.toThrow('We can’t send email right now. Try again later.');
  });

  it('records a paused row and then refuses when an account email is sent at 100', async () => {
    await seed(100, 'today');
    await expect(send('reset')).rejects.toMatchObject({ code: 'EMAIL_CAP_REACHED', status: 503 });
    expect(transport.sent).toHaveLength(0);
    const { rows: paused } = await client.query("select kind from email_delivery where status = 'paused'");
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

  it('records a transport failure', async () => {
    transport.failNext(new Error('smtp down'));
    await expect(send('verify')).resolves.toBe('failed');
    expect(await rows()).toEqual([expect.objectContaining({ status: 'failed', error: 'smtp down', provider_id: null })]);
  });

  it('cuts a long error to 500 characters', async () => {
    transport.failNext(new Error('x'.repeat(2000)));
    await send('verify');
    const { rows: failed } = await client.query("select error from email_delivery where status = 'failed'");
    expect(failed[0].error).toHaveLength(500);
  });

  it('logs a failure with the kind and row id but not the address', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      transport.failNext(new Error('smtp down'));
      await send('verify', 'private.person@example.com');
      const { rows: failed } = await client.query("select id from email_delivery where status = 'failed'");
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('verify');
      expect(logged).toContain(failed[0].id);
      expect(logged).not.toContain('private.person');
    } finally {
      warn.mockRestore();
    }
  });

  it('stores the address as given and keeps the user id', async () => {
    const { rows: users } = await client.query(
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
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'EMAIL_CAP_REACHED' });
    expect(transport.sent).toHaveLength(2);
    const { rows: counted } = await client.query(
      `select count(*)::int as n from email_delivery where status in ('sending', 'sent') and created_at >= ${START_OF_TODAY}`,
    );
    expect(counted[0].n).toBe(100);
  });
});
