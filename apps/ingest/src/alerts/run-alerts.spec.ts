import { buildTopicKey, type TopicFields } from '@rejectradar/contracts';
import { insertEvent, insertFirm } from '@rejectradar/entities';
import {
  alert,
  alertEmail,
  appUser,
  changeEvent,
  type Database,
  emailDelivery,
  firmAlias,
  jobCursor,
  membership,
  notificationPref,
  org,
  prepareTestDatabase,
  uuidv7,
  watchlistItem,
} from '@rejectradar/db';
import { Mailer, type MailMessage, type MailTransport } from '@rejectradar/mail';
import { asc, eq, sql } from 'drizzle-orm';
import { openDb } from '../core/db';
import { ALERTS_CURSOR, runAlerts } from './run-alerts';

/** Records every message instead of sending it; `failNext` makes the next send fail. */
class RecordingTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  private failures = 0;

  failNext(count = 1): void {
    this.failures = count;
  }

  async send(message: MailMessage): Promise<{ providerId: string | null }> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('provider down');
    }
    this.sent.push(message);
    return { providerId: `msg-${this.sent.length}` };
  }
}

const APP_ORIGIN = 'https://app.test';
const topic = (originCountry: string, commodityId: number | null = null, destination: TopicFields['destination'] = null, hazardId: number | null = null) =>
  ({ originCountry, commodityId, destination, hazardId }) satisfies TopicFields;

describe('alerts:run', () => {
  let handle: ReturnType<typeof openDb>;
  let db: Database;
  let transport: RecordingTransport;
  let mailer: Mailer;
  let keys = 0;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_alerts'));
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate org, app_user, change_event, firm, firm_alias, job_cursor, email_delivery restart identity cascade`);
    transport = new RecordingTransport();
    mailer = new Mailer({ db, transport, from: 'RejectRadar <alerts@app.test>' });
  });

  const run = (opts: { mailer?: Mailer | null; batchSize?: number; now?: () => Date } = {}) =>
    runAlerts({ db, mailer: opts.mailer === undefined ? null : opts.mailer, appOrigin: APP_ORIGIN, now: opts.now }, { batchSize: opts.batchSize });

  interface Member {
    verified?: boolean;
    locale?: string;
    /** Omit for a user without a notification_pref row. */
    instantHigh?: boolean;
  }

  /** An account with its members, and the items it watches. Returns the org id and the member emails. */
  async function account(label: string, watch: { firms?: number[]; topics?: TopicFields[] }, members: Member[] = [{}]) {
    const orgId = uuidv7();
    await db.insert(org).values({ id: orgId, name: label });
    const emails: string[] = [];
    for (const [index, member] of members.entries()) {
      const userId = uuidv7();
      const email = `${label}-${index}@example.com`;
      emails.push(email);
      await db.insert(appUser).values({
        id: userId,
        email,
        passwordHash: 'x',
        name: `${label} ${index}`,
        locale: member.locale ?? 'en',
        emailVerifiedAt: member.verified === false ? null : new Date(),
      });
      await db.insert(membership).values({ orgId, userId, role: index === 0 ? 'owner' : 'member' });
      if (member.instantHigh !== undefined) await db.insert(notificationPref).values({ userId, instantHigh: member.instantHigh });
    }
    for (const firmId of watch.firms ?? []) await db.insert(watchlistItem).values({ id: uuidv7(), orgId, kind: 'firm', firmId });
    for (const t of watch.topics ?? []) {
      await db.insert(watchlistItem).values({ id: uuidv7(), orgId, kind: 'topic', topicKey: buildTopicKey(t), ...t });
    }
    return { orgId, emails };
  }

  type EventFields = Partial<Omit<typeof changeEvent.$inferInsert, 'source' | 'sourceKey' | 'kind'>>;
  const refusal = (fields: EventFields = {}) =>
    insertEvent(db, {
      source: 'fda_refusal',
      sourceKey: `k-${++keys}`,
      requiresFirm: true,
      originCountry: 'PK',
      commodityId: 101,
      destination: 'US',
      hazardIds: [300],
      ...fields,
    });
  const rasff = (fields: EventFields = {}) =>
    insertEvent(db, { source: 'rasff', sourceKey: `k-${++keys}`, originCountry: 'PK', commodityId: 101, destination: 'EU', hazardIds: [300], ...fields });

  const alertsOf = async () => db.select().from(alert).orderBy(asc(alert.changeEventId), asc(alert.orgId));
  const cursor = async () => (await db.select().from(jobCursor).where(eq(jobCursor.name, ALERTS_CURSOR)))[0]?.lastId;

  it('a firm event alerts the firm\'s watcher and a matching topic watcher', async () => {
    const f = await insertFirm(db, { displayName: 'Zarfeen Rice Mills' });
    const a = await account('a', { firms: [f] });
    const b = await account('b', { topics: [topic('PK', 100)] });
    await account('c', { topics: [topic('IN')] });
    const eventId = await refusal({ firmId: f });

    const result = await run();

    const rows = await alertsOf();
    expect(rows.map((r) => r.orgId).sort()).toEqual([a.orgId, b.orgId].sort());
    expect(rows.every((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/.test(r.id))).toBe(true);
    expect(rows.every((r) => r.changeEventId === eventId && r.severity === 'high' && r.firmId === f && r.readAt === null)).toBe(true);
    expect(result).toMatchObject({ eventsRead: 1, alertsCreated: 2, cursor: eventId, blocked: null, failBlocked: false });
  });

  it('one alert per account and event', async () => {
    const f = await insertFirm(db);
    const a = await account('a', { firms: [f], topics: [topic('PK'), topic('PK', 101, 'US', 300)] });
    await refusal({ firmId: f });

    const result = await run();

    expect(result.alertsCreated).toBe(1);
    const rows = await alertsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(a.orgId);
  });

  it('matches each part of a topic the way the spec says', async () => {
    // Event: PK, rice (101, below cereals 100), US, aflatoxins (300).
    const matching = [
      topic('PK'),
      topic('PK', 100),
      topic('PK', 101),
      topic('PK', null, 'US'),
      topic('PK', null, null, 300),
      topic('PK', 100, 'US', 300),
    ];
    const missing = [topic('IN'), topic('PK', 102), topic('PK', 200), topic('PK', null, 'EU'), topic('PK', null, null, 301), topic('PK', 100, 'US', 301)];
    const hits = await Promise.all(matching.map((t, i) => account(`hit${i}`, { topics: [t] })));
    await Promise.all(missing.map((t, i) => account(`miss${i}`, { topics: [t] })));
    // An event with no commodity matches only topics that leave the commodity open.
    await refusal({ firmId: null, requiresFirm: false });
    await refusal({ requiresFirm: false, commodityId: null, hazardIds: [] });

    await run();

    const rows = await alertsOf();
    const firstEvent = rows.filter((r) => r.changeEventId === 1).map((r) => r.orgId).sort();
    expect(firstEvent).toEqual(hits.map((h) => h.orgId).sort());
    const secondEvent = rows.filter((r) => r.changeEventId === 2);
    expect(secondEvent).toHaveLength(2); // PK|*|*|* and PK|*|US|*
  });

  it('the cursor stops at an unlinked firm event', async () => {
    const f = await insertFirm(db);
    await account('a', { firms: [f], topics: [topic('PK')] });
    const first = await refusal({ firmId: f });
    const second = await refusal();
    const third = await rasff();

    const blockedRun = await run();

    expect((await alertsOf()).map((r) => r.changeEventId)).toEqual([first]);
    expect(await cursor()).toBe(first);
    expect(blockedRun).toMatchObject({ eventsRead: 1, alertsCreated: 1, cursor: first, failBlocked: false });
    expect(blockedRun.blocked).toMatchObject({ eventId: second });

    await db.update(changeEvent).set({ firmId: f }).where(eq(changeEvent.id, second));
    const next = await run();

    expect((await alertsOf()).map((r) => r.changeEventId)).toEqual([first, second, third]);
    expect(await cursor()).toBe(third);
    expect(next).toMatchObject({ eventsRead: 2, alertsCreated: 2, cursor: third, blocked: null });
  });

  it('a block that is the first event moves nothing', async () => {
    await account('a', { topics: [topic('PK')] });
    const blocked = await refusal();
    await rasff();

    const result = await run();

    expect(result).toMatchObject({ eventsRead: 0, alertsCreated: 0, cursor: 0 });
    expect(result.blocked?.eventId).toBe(blocked);
    expect(await alertsOf()).toEqual([]);
  });

  it('a block older than 48 hours fails the run', async () => {
    await refusal({ firmId: await insertFirm(db) });
    const blocked = await refusal();
    const setAge = (hours: number) => db.execute(sql`update change_event set created_at = now() - make_interval(hours => ${hours}) where id = ${blocked}`);

    await setAge(49);
    const old = await run();
    expect(old.failBlocked).toBe(true);
    expect(old.blocked).toMatchObject({ eventId: blocked });
    expect(old.blocked?.ageHours).toBeGreaterThanOrEqual(49);
    expect(typeof old.blocked?.createdAt).toBe('string');

    await setAge(47);
    const recent = await run();
    expect(recent.failBlocked).toBe(false);
    expect(recent.blocked?.eventId).toBe(blocked);
  });

  it('the injected clock decides the age of a block', async () => {
    await refusal();
    const created = (await db.select({ at: changeEvent.createdAt }).from(changeEvent))[0].at;
    const at = (hours: number) => () => new Date(created.getTime() + hours * 3_600_000);

    expect((await run({ now: at(47.9) })).failBlocked).toBe(false);
    expect((await run({ now: at(48) })).failBlocked).toBe(true);
  });

  it('merged firms: an event on the merged-away firm alerts the survivor\'s watcher', async () => {
    const survivor = await insertFirm(db, { displayName: 'Survivor Foods' });
    const merged = await insertFirm(db, { displayName: 'Merged Foods' });
    await db.insert(firmAlias).values({ oldId: merged, newId: survivor });
    const a = await account('a', { firms: [survivor] });
    await refusal({ firmId: merged });

    await run();

    const rows = await alertsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: a.orgId, firmId: survivor });
  });

  it('a topic alert records the event\'s firm, resolved through the alias', async () => {
    const survivor = await insertFirm(db);
    const merged = await insertFirm(db);
    await db.insert(firmAlias).values({ oldId: merged, newId: survivor });
    await account('a', { topics: [topic('PK')] });
    await refusal({ firmId: merged });
    await rasff();

    await run();

    expect((await alertsOf()).map((r) => r.firmId)).toEqual([survivor, null]);
  });

  it('is idempotent: a second run creates no alerts and sends no emails', async () => {
    const f = await insertFirm(db);
    await account('a', { firms: [f] });
    await refusal({ firmId: f });

    const first = await run({ mailer });
    const second = await run({ mailer });

    expect(first).toMatchObject({ alertsCreated: 1, emails: { sent: 1, paused: 0, failed: 0 } });
    expect(second).toMatchObject({ eventsRead: 0, alertsCreated: 0, emails: { sent: 0, paused: 0, failed: 0 } });
    expect(await alertsOf()).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('two runs at once create each alert once', async () => {
    const f = await insertFirm(db);
    await account('a', { firms: [f] }, [{}]);
    await account('b', { topics: [topic('PK')] }, [{}]);
    for (let i = 0; i < 6; i += 1) await refusal({ firmId: f });

    const results = await Promise.all([run({ mailer, batchSize: 2 }), run({ mailer, batchSize: 2 }), run({ mailer, batchSize: 4 })]);

    expect(await alertsOf()).toHaveLength(12);
    expect(results.reduce((sum, r) => sum + r.alertsCreated, 0)).toBe(12);
    // The cursor lock hands each event to exactly one run.
    expect(results.reduce((sum, r) => sum + r.eventsRead, 0)).toBe(6);
    // Each run emails the alerts it created, so the number of emails depends on how the runs split the events; every alert is emailed once.
    expect(await db.select().from(alertEmail)).toHaveLength(12);
    expect(transport.sent.length).toBeGreaterThanOrEqual(2);
    expect(await cursor()).toBe(6);
  });

  it('works through the events in batches', async () => {
    const f = await insertFirm(db);
    await account('a', { firms: [f] });
    for (let i = 0; i < 5; i += 1) await refusal({ firmId: f });

    const result = await run({ batchSize: 2 });

    expect(result).toMatchObject({ eventsRead: 5, alertsCreated: 5, cursor: 5 });
    expect(await alertsOf()).toHaveLength(5);
  });

  it('stops at a block in a later batch and keeps the earlier batches', async () => {
    const f = await insertFirm(db);
    await account('a', { firms: [f] });
    await refusal({ firmId: f });
    await refusal({ firmId: f });
    await refusal({ firmId: f });
    const blocked = await refusal();
    await refusal({ firmId: f });

    const result = await run({ batchSize: 2 });

    expect(result).toMatchObject({ eventsRead: 3, alertsCreated: 3, cursor: 3 });
    expect(result.blocked?.eventId).toBe(blocked);
  });

  it('with nothing to do, it reads nothing and leaves the cursor alone', async () => {
    expect(await run()).toEqual({ eventsRead: 0, alertsCreated: 0, emails: { sent: 0, paused: 0, failed: 0 }, cursor: 0, blocked: null, failBlocked: false });
  });

  describe('instant emails', () => {
    it('sends one email per verified member with instant email on, in their language, covering all the high alerts', async () => {
      const f1 = await insertFirm(db, { displayName: 'Zarfeen Rice Mills' });
      const f2 = await insertFirm(db, { displayName: 'Indus Agro Exports' });
      const a = await account('a', { firms: [f1, f2] }, [
        { locale: 'en' },
        { locale: 'ur', instantHigh: true },
        { verified: false },
        { instantHigh: false },
      ]);
      await refusal({ firmId: f1 });
      await refusal({ firmId: f2 });

      const result = await run({ mailer });

      expect(result).toMatchObject({ alertsCreated: 2, emails: { sent: 2, paused: 0, failed: 0 } });
      expect(transport.sent.map((m) => m.to).sort()).toEqual([a.emails[0], a.emails[1]].sort());
      for (const message of transport.sent) {
        expect(message.from).toBe('RejectRadar <alerts@app.test>');
        expect(message.text).toContain('Zarfeen Rice Mills');
        expect(message.text).toContain('Indus Agro Exports');
        expect(message.text).toContain(`${APP_ORIGIN}/alerts`);
        expect(message.text).toContain(`${APP_ORIGIN}/settings`);
      }
      const urdu = transport.sent.find((m) => m.to === a.emails[1]);
      const english = transport.sent.find((m) => m.to === a.emails[0]);
      expect(urdu?.html).toContain('dir="rtl"');
      expect(english?.html).not.toContain('dir="rtl"');
      expect(urdu?.subject).not.toBe(english?.subject);

      const recorded = await db.select().from(alertEmail);
      expect(recorded).toHaveLength(4); // 2 alerts x 2 recipients
      const alertIds = (await alertsOf()).map((r) => r.id).sort();
      expect([...new Set(recorded.map((r) => r.alertId))].sort()).toEqual(alertIds);
      const deliveries = await db.select().from(emailDelivery);
      expect(deliveries.map((d) => [d.kind, d.status])).toEqual([['instant_alert', 'sent'], ['instant_alert', 'sent']]);
    });

    it('a user in two accounts gets one email for the alerts of both', async () => {
      const f = await insertFirm(db, { displayName: 'Zarfeen Rice Mills' });
      const first = await account('a', { firms: [f] });
      const second = await account('b', { topics: [topic('PK')] }, []);
      const [user] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.email, first.emails[0]));
      await db.insert(membership).values({ orgId: second.orgId, userId: user.id, role: 'member' });
      await refusal({ firmId: f });

      await run({ mailer });

      expect(transport.sent).toHaveLength(1);
      expect(await db.select().from(alertEmail)).toHaveLength(2);
    });

    it('sends nothing for a normal-severity alert', async () => {
      await account('a', { topics: [topic('PK')] });
      await rasff();

      const result = await run({ mailer });

      expect(result).toMatchObject({ alertsCreated: 1, emails: { sent: 0, paused: 0, failed: 0 } });
      expect(transport.sent).toEqual([]);
      expect(await db.select().from(alertEmail)).toEqual([]);
    });

    it('sends nothing to the members of a deactivated account, which still gets its alert', async () => {
      const active = await account('active', { topics: [topic('PK')] });
      const closed = await account('closed', { topics: [topic('PK')] });
      await db.update(org).set({ deactivatedAt: new Date() }).where(eq(org.id, closed.orgId));
      await refusal({ requiresFirm: false });

      const result = await run({ mailer });

      expect(result).toMatchObject({ alertsCreated: 2, emails: { sent: 1, paused: 0, failed: 0 } });
      expect((await alertsOf()).map((r) => r.orgId).sort()).toEqual([active.orgId, closed.orgId].sort());
      expect(transport.sent.map((m) => m.to)).toEqual(active.emails);
      expect(await db.select().from(alertEmail)).toHaveLength(1);
    });

    it('an account without members gets its alert and no email', async () => {
      await account('nobody', { topics: [topic('PK')] }, []);
      await refusal({ requiresFirm: false });

      const result = await run({ mailer });

      expect(result).toMatchObject({ alertsCreated: 1, emails: { sent: 0, paused: 0, failed: 0 } });
    });

    it('is paused at the cap and records no alert_email rows', async () => {
      await account('a', { topics: [topic('PK')] });
      await refusal({ requiresFirm: false });
      await db.execute(sql`insert into email_delivery (id, to_email, kind, status) select gen_random_uuid(), 'seed@example.com', 'verify', 'sent' from generate_series(1, 70)`);

      const result = await run({ mailer });

      expect(result).toMatchObject({ alertsCreated: 1, emails: { sent: 0, paused: 1, failed: 0 } });
      expect(transport.sent).toEqual([]);
      expect(await db.select().from(alertEmail)).toEqual([]);
    });

    it('a failed send is counted and records no alert_email rows', async () => {
      await account('a', { topics: [topic('PK')] }, [{}, {}]);
      await refusal({ requiresFirm: false });
      transport.failNext();

      const result = await run({ mailer });

      expect(result).toMatchObject({ alertsCreated: 1, emails: { sent: 1, paused: 0, failed: 1 } });
      expect(await db.select().from(alertEmail)).toHaveLength(1);
    });

    it('--no-email (no mailer) creates the alerts and writes no email_delivery rows', async () => {
      await account('a', { topics: [topic('PK')] });
      await refusal({ requiresFirm: false });

      const result = await run({ mailer: null });

      expect(result).toMatchObject({ alertsCreated: 1, emails: { sent: 0, paused: 0, failed: 0 } });
      expect(await db.select().from(emailDelivery)).toEqual([]);
      expect(await db.select().from(alertEmail)).toEqual([]);
    });
  });
});
