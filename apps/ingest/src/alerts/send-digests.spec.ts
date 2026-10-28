import { insertEvent, insertFirm } from '@rejectradar/entities';
import {
  alert,
  alertEmail,
  appUser,
  type Database,
  emailDelivery,
  membership,
  notificationPref,
  org,
  prepareTestDatabase,
  uuidv7,
} from '@rejectradar/db';
import { CATALOGS } from '@rejectradar/i18n';
import { Mailer, type MailMessage, type MailTransport } from '@rejectradar/mail';
import { eq, sql } from 'drizzle-orm';
import { openDb } from '../core/db';
import { DIGEST_MAX_ITEMS, sendDigests } from './send-digests';

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
/** A Wednesday and the Monday after it, in UTC. */
const WEDNESDAY = new Date('2026-10-28T03:00:00Z');
const MONDAY = new Date('2026-11-02T03:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (from: Date, ms: number) => new Date(from.getTime() - ms);

describe('digest:send', () => {
  let handle: ReturnType<typeof openDb>;
  let db: Database;
  let transport: RecordingTransport;
  let mailer: Mailer;
  let keys = 0;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_digests'));
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate org, app_user, change_event, firm, email_delivery restart identity cascade`);
    transport = new RecordingTransport();
    mailer = new Mailer({ db, transport, from: 'RejectRadar <alerts@app.test>' });
  });

  const run = (now: Date) => sendDigests({ db, mailer, appOrigin: APP_ORIGIN, now: () => now });

  interface Member {
    verified?: boolean;
    locale?: string;
    /** Omit for a user without a notification_pref row (daily). */
    digest?: 'daily' | 'weekly';
    lastDigestAt?: Date;
    instantHigh?: boolean;
    /** The user has no membership: a removed member. */
    removed?: boolean;
  }

  /** An account with its members. Returns the org id, the member emails and their user ids. */
  async function account(label: string, members: Member[] = [{}], opts: { deactivated?: boolean } = {}) {
    const orgId = uuidv7();
    await db.insert(org).values({ id: orgId, name: label, deactivatedAt: opts.deactivated ? new Date() : null });
    const emails: string[] = [];
    const userIds: string[] = [];
    for (const [index, member] of members.entries()) {
      const userId = uuidv7();
      const email = `${label}-${index}@example.com`;
      emails.push(email);
      userIds.push(userId);
      await db.insert(appUser).values({
        id: userId,
        email,
        passwordHash: 'x',
        name: `${label} ${index}`,
        locale: member.locale ?? 'en',
        emailVerifiedAt: member.verified === false ? null : new Date(),
      });
      if (!member.removed) await db.insert(membership).values({ orgId, userId, role: index === 0 ? 'owner' : 'member' });
      if (member.digest !== undefined || member.lastDigestAt !== undefined || member.instantHigh !== undefined) {
        await db.insert(notificationPref).values({
          userId,
          digest: member.digest ?? 'daily',
          lastDigestAt: member.lastDigestAt ?? null,
          instantHigh: member.instantHigh ?? true,
        });
      }
    }
    return { orgId, emails, userIds };
  }

  interface AlertOptions {
    firmId?: number | null;
    createdAt: Date;
    read?: boolean;
    severity?: 'high' | 'normal';
    originCountry?: string | null;
    commodityId?: number | null;
  }

  /** An alert of `orgId` on a fresh event, created at the given time. */
  async function addAlert(orgId: string, opts: AlertOptions) {
    const eventId = await insertEvent(db, {
      source: 'rasff',
      sourceKey: `k-${++keys}`,
      originCountry: opts.originCountry === undefined ? 'PK' : opts.originCountry,
      commodityId: opts.commodityId === undefined ? 101 : opts.commodityId,
      destination: 'EU',
      firmId: opts.firmId ?? null,
    });
    const id = uuidv7();
    await db.insert(alert).values({
      id,
      orgId,
      changeEventId: eventId,
      firmId: opts.firmId ?? null,
      severity: opts.severity ?? 'normal',
      createdAt: opts.createdAt,
      readAt: opts.read ? opts.createdAt : null,
    });
    return id;
  }

  const prefOf = async (userId: string) => (await db.select().from(notificationPref).where(eq(notificationPref.userId, userId)))[0];
  const deliveries = () => db.select().from(emailDelivery);
  const titlesOf = (message: MailMessage) => [...message.html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
  const countOf = (text: string, part: string) => text.split(part).length - 1;

  it('daily users get their unread alerts since the last digest', async () => {
    const a = await account('a', [{ lastDigestAt: ago(WEDNESDAY, 2 * DAY) }, {}]);
    const firmOne = await insertFirm(db, { displayName: 'Zarfeen Rice Mills' });
    const firmTwo = await insertFirm(db, { displayName: 'Indus Agro Exports' });
    await addAlert(a.orgId, { firmId: firmOne, createdAt: ago(WEDNESDAY, 3 * DAY) }); // before both windows
    await addAlert(a.orgId, { firmId: firmOne, createdAt: ago(WEDNESDAY, 30 * HOUR) }); // only the first user's window reaches it
    await addAlert(a.orgId, { firmId: firmTwo, createdAt: ago(WEDNESDAY, 2 * HOUR) });

    const result = await run(WEDNESDAY);

    expect(result).toEqual({ users: 2, sent: 2, paused: 0, failed: 0, empty: 0 });
    const first = transport.sent.find((m) => m.to === a.emails[0]);
    const second = transport.sent.find((m) => m.to === a.emails[1]);
    expect(first?.from).toBe('RejectRadar <alerts@app.test>');
    expect(countOf(first?.text ?? '', 'Zarfeen Rice Mills')).toBe(2); // group title + item
    expect(first?.text).toContain('Indus Agro Exports');
    expect(first?.text).toContain(`${APP_ORIGIN}/alerts`);
    expect(first?.text).toContain(`${APP_ORIGIN}/settings`);
    // The second user has no pref row, so the window is the last day.
    expect(second?.text).not.toContain('Zarfeen Rice Mills');
    expect(second?.text).toContain('Indus Agro Exports');
    expect((await prefOf(a.userIds[0])).lastDigestAt).toEqual(WEDNESDAY);
    expect((await prefOf(a.userIds[1])).lastDigestAt).toEqual(WEDNESDAY);
    expect((await deliveries()).map((d) => [d.kind, d.status])).toEqual([['digest', 'sent'], ['digest', 'sent']]);
  });

  it('already-emailed high alerts are left out, and stay in a teammate\'s digest who has instant email off', async () => {
    const a = await account('a', [{}, { instantHigh: false }]);
    const emailed = await insertFirm(db, { displayName: 'Emailed Foods' });
    const other = await insertFirm(db, { displayName: 'Other Foods' });
    const emailedAlert = await addAlert(a.orgId, { firmId: emailed, createdAt: ago(WEDNESDAY, 5 * HOUR), severity: 'high' });
    await addAlert(a.orgId, { firmId: other, createdAt: ago(WEDNESDAY, 4 * HOUR) });
    await db.insert(alertEmail).values({ alertId: emailedAlert, userId: a.userIds[0] });

    const result = await run(WEDNESDAY);

    expect(result).toMatchObject({ users: 2, sent: 2 });
    const mine = transport.sent.find((m) => m.to === a.emails[0]);
    const teammate = transport.sent.find((m) => m.to === a.emails[1]);
    expect(mine?.text).not.toContain('Emailed Foods');
    expect(mine?.text).toContain('Other Foods');
    expect(teammate?.text).toContain('Emailed Foods');
    expect(teammate?.text).toContain('Other Foods');
  });

  it('weekly users only on Mondays, with a 7-day window when there is no last digest', async () => {
    const a = await account('a', [{ digest: 'weekly' }]);
    const f = await insertFirm(db, { displayName: 'Weekly Foods' });
    const old = await insertFirm(db, { displayName: 'Too Old Foods' });
    await addAlert(a.orgId, { firmId: f, createdAt: ago(MONDAY, 6 * DAY) });
    await addAlert(a.orgId, { firmId: old, createdAt: ago(MONDAY, 8 * DAY) });

    const wednesday = await run(WEDNESDAY);
    expect(wednesday).toEqual({ users: 0, sent: 0, paused: 0, failed: 0, empty: 0 });
    expect(transport.sent).toEqual([]);
    expect((await prefOf(a.userIds[0])).lastDigestAt).toBeNull();

    const monday = await run(MONDAY);
    expect(monday).toEqual({ users: 1, sent: 1, paused: 0, failed: 0, empty: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].subject).toBe('Your weekly RejectRadar digest');
    expect(transport.sent[0].text).toContain('Weekly Foods');
    expect(transport.sent[0].text).not.toContain('Too Old Foods');
    expect((await prefOf(a.userIds[0])).lastDigestAt).toEqual(MONDAY);
  });

  it('daily users get their digest on a Monday too', async () => {
    const a = await account('a', [{}]);
    await addAlert(a.orgId, { createdAt: ago(MONDAY, HOUR) });

    expect(await run(MONDAY)).toMatchObject({ users: 1, sent: 1 });
  });

  it('nothing to report sends nothing but moves the window', async () => {
    const a = await account('a', [{}, { lastDigestAt: ago(WEDNESDAY, 3 * DAY) }]);
    const result = await run(WEDNESDAY);

    expect(result).toEqual({ users: 2, sent: 0, paused: 0, failed: 0, empty: 2 });
    expect(transport.sent).toEqual([]);
    expect(await deliveries()).toEqual([]);
    expect((await prefOf(a.userIds[0])).lastDigestAt).toEqual(WEDNESDAY);
    expect((await prefOf(a.userIds[1])).lastDigestAt).toEqual(WEDNESDAY);
    expect((await prefOf(a.userIds[0])).digest).toBe('daily');
  });

  it('a second run on the same day finds nothing new', async () => {
    const a = await account('a', [{}]);
    await addAlert(a.orgId, { createdAt: ago(WEDNESDAY, HOUR) });

    expect(await run(WEDNESDAY)).toMatchObject({ sent: 1 });
    expect(await run(WEDNESDAY)).toMatchObject({ sent: 0, empty: 1 });
    expect(transport.sent).toHaveLength(1);
  });

  it('a paused digest covers both days next time', async () => {
    const tuesday = new Date('2026-10-27T03:00:00Z');
    const thursday = new Date('2026-10-29T03:00:00Z');
    const a = await account('a', [{ lastDigestAt: tuesday }]);
    const first = await insertFirm(db, { displayName: 'Tuesday Foods' });
    const second = await insertFirm(db, { displayName: 'Wednesday Foods' });
    await addAlert(a.orgId, { firmId: first, createdAt: new Date('2026-10-27T10:00:00Z') });
    await addAlert(a.orgId, { firmId: second, createdAt: new Date('2026-10-28T10:00:00Z') });

    // The mailer counts "today" on the database clock (UTC midnight to now), not on the clock given to the run.
    // 90 sent rows created now are today's for the mailer, whatever date the run believes it is.
    await db.execute(sql`insert into email_delivery (id, to_email, kind, status) select gen_random_uuid(), 'seed@example.com', 'verify', 'sent' from generate_series(1, 90)`);

    // Day one: Wednesday 03:00 run (the window holds Tuesday's alert). The cap is used up.
    const paused = await run(WEDNESDAY);
    expect(paused).toEqual({ users: 1, sent: 0, paused: 1, failed: 0, empty: 0 });
    expect(transport.sent).toEqual([]);
    expect((await prefOf(a.userIds[0])).lastDigestAt).toEqual(tuesday);

    // "The next day": the cap resets at UTC midnight on the database clock, so the 90 rows are moved back by one day.
    await db.execute(sql`update email_delivery set created_at = created_at - interval '1 day' where status = 'sent'`);

    // Day two: Thursday 03:00 run. The window still starts at Tuesday, so one email holds both days.
    const sent = await run(thursday);
    expect(sent).toEqual({ users: 1, sent: 1, paused: 0, failed: 0, empty: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toContain('Tuesday Foods');
    expect(transport.sent[0].text).toContain('Wednesday Foods');
    expect((await prefOf(a.userIds[0])).lastDigestAt).toEqual(thursday);
    const digests = (await deliveries()).filter((d) => d.kind === 'digest').map((d) => d.status).sort();
    expect(digests).toEqual(['paused', 'sent']);
  });

  it('a failed send keeps the window and is counted', async () => {
    const a = await account('a', [{}]);
    await addAlert(a.orgId, { createdAt: ago(WEDNESDAY, HOUR) });
    transport.failNext();

    const failed = await run(WEDNESDAY);

    expect(failed).toEqual({ users: 1, sent: 0, paused: 0, failed: 1, empty: 0 });
    expect((await prefOf(a.userIds[0]))?.lastDigestAt ?? null).toBeNull();
    expect(await run(WEDNESDAY)).toMatchObject({ sent: 1 });
  });

  it('read alerts are left out', async () => {
    const a = await account('a', [{}]);
    const read = await insertFirm(db, { displayName: 'Read Foods' });
    const unread = await insertFirm(db, { displayName: 'Unread Foods' });
    await addAlert(a.orgId, { firmId: read, createdAt: ago(WEDNESDAY, 3 * HOUR), read: true });
    await addAlert(a.orgId, { firmId: unread, createdAt: ago(WEDNESDAY, 2 * HOUR) });

    await run(WEDNESDAY);

    expect(transport.sent[0].text).not.toContain('Read Foods');
    expect(transport.sent[0].text).toContain('Unread Foods');
  });

  it('removed members, unverified users and the members of a deactivated account get nothing', async () => {
    const alive = await account('alive', [{}, { verified: false }, { removed: true }]);
    const closed = await account('closed', [{}], { deactivated: true });
    await addAlert(alive.orgId, { createdAt: ago(WEDNESDAY, HOUR) });
    await addAlert(closed.orgId, { createdAt: ago(WEDNESDAY, HOUR) });

    const result = await run(WEDNESDAY);

    expect(result).toEqual({ users: 1, sent: 1, paused: 0, failed: 0, empty: 0 });
    expect(transport.sent.map((m) => m.to)).toEqual([alive.emails[0]]);
    // The deactivated account's alerts wait for a reactivation: nobody's window moved.
    expect(await prefOf(closed.userIds[0])).toBeUndefined();
    expect(await prefOf(alive.userIds[1])).toBeUndefined();
  });

  it('a user in two accounts gets one email for both, and a user in a deactivated and an active account only the active one', async () => {
    const first = await account('a', [{}]);
    const second = await account('b', []);
    const closed = await account('c', []);
    await db.update(org).set({ deactivatedAt: new Date() }).where(eq(org.id, closed.orgId));
    await db.insert(membership).values([
      { orgId: second.orgId, userId: first.userIds[0], role: 'member' },
      { orgId: closed.orgId, userId: first.userIds[0], role: 'member' },
    ]);
    const f1 = await insertFirm(db, { displayName: 'First Account Foods' });
    const f2 = await insertFirm(db, { displayName: 'Second Account Foods' });
    const f3 = await insertFirm(db, { displayName: 'Closed Account Foods' });
    await addAlert(first.orgId, { firmId: f1, createdAt: ago(WEDNESDAY, HOUR) });
    await addAlert(second.orgId, { firmId: f2, createdAt: ago(WEDNESDAY, HOUR) });
    await addAlert(closed.orgId, { firmId: f3, createdAt: ago(WEDNESDAY, HOUR) });

    const result = await run(WEDNESDAY);

    expect(result).toMatchObject({ users: 1, sent: 1 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toContain('First Account Foods');
    expect(transport.sent[0].text).toContain('Second Account Foods');
    expect(transport.sent[0].text).not.toContain('Closed Account Foods');
  });

  it('more than 50: 60 alerts render 50 items and a line for the other 10', async () => {
    const a = await account('a', [{}]);
    const f = await insertFirm(db, { displayName: 'Busy Foods' });
    for (let i = 0; i < 60; i += 1) await addAlert(a.orgId, { firmId: f, createdAt: ago(WEDNESDAY, (i + 1) * 60_000) });

    await run(WEDNESDAY);

    expect(DIGEST_MAX_ITEMS).toBe(50);
    const message = transport.sent[0];
    expect(countOf(message.text, CATALOGS.en['email.alertItem.view'])).toBe(50);
    expect(message.text).toContain('10 more alerts are waiting in your account.');
    expect((await prefOf(a.userIds[0])).lastDigestAt).toEqual(WEDNESDAY);
  });

  it('groups: one group per firm, topic-only alerts by origin and commodity', async () => {
    const a = await account('a', [{}]);
    const firm = await insertFirm(db, { displayName: 'Zarfeen Rice Mills' });
    await addAlert(a.orgId, { firmId: firm, createdAt: ago(WEDNESDAY, 1 * HOUR) });
    await addAlert(a.orgId, { firmId: firm, createdAt: ago(WEDNESDAY, 2 * HOUR), originCountry: 'IN' });
    await addAlert(a.orgId, { createdAt: ago(WEDNESDAY, 3 * HOUR) }); // PK, rice
    await addAlert(a.orgId, { createdAt: ago(WEDNESDAY, 4 * HOUR) }); // PK, rice
    await addAlert(a.orgId, { createdAt: ago(WEDNESDAY, 5 * HOUR), originCountry: 'IN', commodityId: null });
    await addAlert(a.orgId, { createdAt: ago(WEDNESDAY, 6 * HOUR), originCountry: null, commodityId: 101 });
    await addAlert(a.orgId, { createdAt: ago(WEDNESDAY, 7 * HOUR), originCountry: null, commodityId: null });

    await run(WEDNESDAY);

    expect(titlesOf(transport.sent[0])).toEqual([
      'Zarfeen Rice Mills',
      'Pakistan \u00d7 Rice',
      'India',
      'Rice',
      'Other alerts',
    ]);
    // Two alerts of the firm sit under its one title.
    const html = transport.sent[0].html;
    expect(countOf(html, 'Zarfeen Rice Mills')).toBe(3);
  });

  it('titles topic groups in the user\'s language', async () => {
    const a = await account('a', [{ locale: 'hi' }]);
    await addAlert(a.orgId, { createdAt: ago(WEDNESDAY, HOUR) });

    await run(WEDNESDAY);

    const [title] = titlesOf(transport.sent[0]);
    expect(title).toContain(new Intl.DisplayNames(['hi'], { type: 'region' }).of('PK'));
    expect(title).toContain(CATALOGS.hi['taxonomy.commodity.rice']);
    expect(title).not.toContain('Pakistan');
  });
});
