import { insertEvent } from '@rejectradar/entities';
import {
  alert,
  alertEmail,
  appUser,
  bulkJob,
  bulkJobRow,
  type Database,
  emailDelivery,
  emailToken,
  invite,
  org,
  paddleEvent,
  prepareTestDatabase,
  refreshToken,
  uuidv7,
} from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import { openDb } from '../core/db';
import { purge } from './purge';

const NOW = new Date('2026-10-29T02:30:00.000Z');
const DAY_MS = 86_400_000;
/** A moment `days` days (fractions allowed) before the fixed `now`; negative means after it. */
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

describe('maintenance:purge', () => {
  let handle: ReturnType<typeof openDb>;
  let db: Database;
  let orgId: string;
  let userId: string;
  let keys = 0;

  beforeAll(async () => {
    handle = openDb(await prepareTestDatabase('ingest_purge'));
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate org, app_user, change_event, paddle_event, email_delivery restart identity cascade`);
    orgId = uuidv7();
    userId = uuidv7();
    await db.insert(org).values({ id: orgId, name: 'Acme' });
    await db.insert(appUser).values({ id: userId, email: 'u@example.com', passwordHash: 'x', name: 'U' });
  });

  async function job(status: 'queued' | 'running' | 'finished', finishedAt: Date | null, rows = 2) {
    const id = uuidv7();
    await db.insert(bulkJob).values({ id, orgId, fileName: 'f.csv', status, total: rows, finishedAt });
    for (let i = 1; i <= rows; i += 1) await db.insert(bulkJobRow).values({ jobId: id, rowNr: i, inputName: `Firm ${i}`, inputCountry: 'PK' });
    return id;
  }
  const rowsOf = async (jobId: string) => (await db.select().from(bulkJobRow).where(eq(bulkJobRow.jobId, jobId))).length;
  const hash = () => `h-${++keys}`;
  const event = () => insertEvent(db, { source: 'rasff', sourceKey: `k-${++keys}`, originCountry: 'PK', commodityId: 101, destination: 'EU', hazardIds: [300] });

  it('bulk rows go 30 days after the job finished', async () => {
    const old = await job('finished', ago(31));
    const recent = await job('finished', ago(29));
    const running = await job('running', null);
    const queued = await job('queued', null);

    const counts = await purge(db, NOW);

    expect(counts.bulkRows).toBe(2);
    expect(await rowsOf(old)).toBe(0);
    expect(await rowsOf(recent)).toBe(2);
    expect(await rowsOf(running)).toBe(2);
    expect(await rowsOf(queued)).toBe(2);
    // The job row stays as a record.
    expect((await db.select().from(bulkJob).where(eq(bulkJob.id, old))).length).toBe(1);
  });

  it('paddle payloads are cleared after 90 days', async () => {
    const processedAt = ago(89);
    await db.insert(paddleEvent).values([
      { eventId: 'old', type: 'subscription.updated', receivedAt: ago(91), processedAt, payload: { a: 1 } },
      { eventId: 'new', type: 'subscription.updated', receivedAt: ago(89), processedAt, payload: { a: 2 } },
    ]);

    const counts = await purge(db, NOW);

    expect(counts.paddlePayloads).toBe(1);
    const rows = Object.fromEntries((await db.select().from(paddleEvent)).map((r) => [r.eventId, r]));
    expect(rows['old'].payload).toBeNull();
    expect(rows['old'].processedAt?.toISOString()).toBe(processedAt.toISOString());
    expect(rows['new'].payload).toEqual({ a: 2 });
  });

  it('email logs and alert emails after 90 days', async () => {
    await db.insert(emailDelivery).values([
      { id: uuidv7(), toEmail: 'a@example.com', kind: 'digest', status: 'sent', createdAt: ago(91) },
      { id: uuidv7(), toEmail: 'b@example.com', kind: 'digest', status: 'sent', createdAt: ago(89) },
    ]);
    const otherUser = uuidv7();
    await db.insert(appUser).values({ id: otherUser, email: 'v@example.com', passwordHash: 'x', name: 'V' });
    const alertId = uuidv7();
    await db.insert(alert).values({ id: alertId, orgId, changeEventId: await event(), severity: 'high' });
    await db.insert(alertEmail).values([
      { alertId, userId, createdAt: ago(91) },
      { alertId, userId: otherUser, createdAt: ago(89) },
    ]);

    const counts = await purge(db, NOW);

    expect(counts).toMatchObject({ emailDeliveries: 1, alertEmails: 1 });
    expect((await db.select().from(emailDelivery)).map((r) => r.toEmail)).toEqual(['b@example.com']);
    expect((await db.select().from(alertEmail)).map((r) => r.userId)).toEqual([otherUser]);
  });

  it('tokens and invites: used or expired more than 30 days ago are deleted', async () => {
    const e = { expiredOld: hash(), expiredRecent: hash(), unexpired: hash(), usedOld: hash(), usedRecent: hash() };
    await db.insert(emailToken).values([
      { id: uuidv7(), userId, purpose: 'verify', tokenHash: e.expiredOld, expiresAt: ago(31) },
      { id: uuidv7(), userId, purpose: 'verify', tokenHash: e.expiredRecent, expiresAt: ago(29) },
      { id: uuidv7(), userId, purpose: 'reset', tokenHash: e.unexpired, expiresAt: ago(-1) },
      // Used 31 days ago, and expired before that: both are over 30 days ago.
      { id: uuidv7(), userId, purpose: 'reset', tokenHash: e.usedOld, expiresAt: ago(32), usedAt: ago(31) },
      // Expired long ago but used only 29 days ago: the later moment is inside the window.
      { id: uuidv7(), userId, purpose: 'reset', tokenHash: e.usedRecent, expiresAt: ago(40), usedAt: ago(29) },
    ]);
    const r = { expiredOld: hash(), expiredRecent: hash(), unexpired: hash(), revokedOld: hash(), revokedRecent: hash() };
    const family = uuidv7();
    await db.insert(refreshToken).values([
      { id: uuidv7(), userId, familyId: family, tokenHash: r.expiredOld, expiresAt: ago(31) },
      { id: uuidv7(), userId, familyId: family, tokenHash: r.expiredRecent, expiresAt: ago(29) },
      { id: uuidv7(), userId, familyId: family, tokenHash: r.unexpired, expiresAt: ago(-5) },
      { id: uuidv7(), userId, familyId: family, tokenHash: r.revokedOld, expiresAt: ago(32), revokedAt: ago(31) },
      { id: uuidv7(), userId, familyId: family, tokenHash: r.revokedRecent, expiresAt: ago(40), revokedAt: ago(29) },
    ]);
    const i = { expiredOld: hash(), expiredRecent: hash(), unexpired: hash(), acceptedOld: hash(), acceptedRecent: hash() };
    const inv = (tokenHash: string, expiresAt: Date, acceptedAt?: Date) =>
      ({ id: uuidv7(), orgId, email: `${tokenHash}@example.com`, role: 'member', tokenHash, expiresAt, acceptedAt }) as const;
    await db.insert(invite).values([
      inv(i.expiredOld, ago(31)),
      inv(i.expiredRecent, ago(29)),
      inv(i.unexpired, ago(-3)),
      inv(i.acceptedOld, ago(32), ago(31)),
      inv(i.acceptedRecent, ago(40), ago(29)),
    ]);

    const counts = await purge(db, NOW);

    expect(counts).toMatchObject({ emailTokens: 2, refreshTokens: 2, invites: 2 });
    const left = async (table: typeof emailToken | typeof refreshToken | typeof invite) => (await db.select({ h: table.tokenHash }).from(table)).map((x) => x.h).sort();
    expect(await left(emailToken)).toEqual([e.expiredRecent, e.unexpired, e.usedRecent].sort());
    expect(await left(refreshToken)).toEqual([r.expiredRecent, r.unexpired, r.revokedRecent].sort());
    expect(await left(invite)).toEqual([i.expiredRecent, i.unexpired, i.acceptedRecent].sort());
  });

  it('alerts are kept (P6-D11)', async () => {
    await db.insert(alert).values({ id: uuidv7(), orgId, changeEventId: await event(), severity: 'high', createdAt: ago(400), readAt: ago(399) });

    await purge(db, NOW);

    expect((await db.select().from(alert)).length).toBe(1);
  });

  it('is idempotent: a second run returns all zeros', async () => {
    await job('finished', ago(31));
    await db.insert(paddleEvent).values({ eventId: 'old', type: 't', receivedAt: ago(91), payload: { a: 1 } });
    await db.insert(emailDelivery).values({ id: uuidv7(), toEmail: 'a@example.com', kind: 'digest', status: 'sent', createdAt: ago(91) });
    await db.insert(emailToken).values({ id: uuidv7(), userId, purpose: 'verify', tokenHash: hash(), expiresAt: ago(31) });

    const first = await purge(db, NOW);
    expect(first).toMatchObject({ bulkRows: 2, paddlePayloads: 1, emailDeliveries: 1, emailTokens: 1 });

    expect(await purge(db, NOW)).toEqual({ bulkRows: 0, paddlePayloads: 0, emailDeliveries: 0, alertEmails: 0, emailTokens: 0, refreshTokens: 0, invites: 0 });
  });
});
