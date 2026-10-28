import { type Destination, type EventKind, LOCALES, type Locale, NOTICE_DESTINATION, type NoticeSource, type Severity } from '@rejectradar/contracts';
import {
  alert,
  alertEmail,
  appUser,
  changeEvent,
  type Database,
  firm,
  jobCursor,
  membership,
  notice,
  notificationPref,
  org,
  topicMatchesItem,
} from '@rejectradar/db';
import { type AlertEmailItem, type Mailer, renderInstantAlertEmail } from '@rejectradar/mail';
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

/** The `job_cursor` row that remembers the last `change_event` turned into alerts. */
export const ALERTS_CURSOR = 'alerts';
/** A firm-level event still without a firm after this many hours fails the run (P5-D14). */
export const ALERTS_BLOCKED_FAIL_HOURS = 48;

const DEFAULT_BATCH_SIZE = 1000;
/** An instant email lists at most this many alerts; the rest stay out of `alert_email`, so the next digest carries them (P5-D13). */
const MAX_EMAIL_ITEMS = 50;
/** Ids per query, far below Postgres' limit of 65,535 parameters. */
const ID_CHUNK = 5000;

export interface AlertsRunResult {
  /** Events turned into alerts (or into nothing, when no account watches them) in this run. */
  eventsRead: number;
  alertsCreated: number;
  emails: { sent: number; paused: number; failed: number };
  /** The id of the last event processed; the next run starts after it. */
  cursor: number;
  /** The firm-level event without a firm that stopped the cursor, if any. */
  blocked: { eventId: number; createdAt: string; ageHours: number } | null;
  /** The blocking event is at least `ALERTS_BLOCKED_FAIL_HOURS` old. */
  failBlocked: boolean;
}

export interface AlertsDeps {
  db: Database;
  /** `null` creates the alerts and sends nothing (`--no-email`). */
  mailer: Mailer | null;
  /** The web app's origin, for the links in the emails; unused without a mailer. */
  appOrigin: string;
  now?: () => Date;
}

/**
 * A version 7 UUID made by Postgres, so one `insert ... select` can number every row it inserts: the current
 * millisecond in the first 48 bits and random bits after, with the version bits set. Works on every Postgres 13+.
 */
const UUIDV7 = sql`encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid`;

interface NewAlert {
  id: string;
  orgId: string;
  severity: Severity;
}

interface BatchResult {
  eventsRead: number;
  created: NewAlert[];
  cursor: number;
  blocked: { eventId: number; createdAt: Date } | null;
  /** No more events to read in this run. */
  done: boolean;
}

/** The events of one batch, each with its firm resolved through `firm_alias` (always one hop). */
function eventsBetween(lastId: number, upTo: number) {
  return sql`select ce.id, ce.severity, ce.origin_country, ce.commodity_id, ce.destination, ce.hazard_ids,
      coalesce(fa.new_id, ce.firm_id) as firm_id
    from change_event ce
    left join firm_alias fa on fa.old_id = ce.firm_id
    where ce.id > ${lastId} and ce.id <= ${upTo}`;
}

/** Alerts for the accounts that watch the event's firm. One alert per (account, event): a row that exists is left as it is. */
function insertFirmAlerts(lastId: number, upTo: number) {
  return sql`with e as (${eventsBetween(lastId, upTo)})
    insert into alert (id, org_id, change_event_id, firm_id, severity)
    select ${UUIDV7}, w.org_id, e.id, e.firm_id, e.severity
    from e
    join watchlist_item w on w.kind = 'firm' and w.firm_id = e.firm_id
    where e.firm_id is not null
    on conflict (org_id, change_event_id) do nothing
    returning id, org_id, severity`;
}

/** Alerts for the accounts whose watched topic the event falls inside (spec §11). An account with several matching topics still gets one. */
function insertTopicAlerts(lastId: number, upTo: number) {
  const match = topicMatchesItem(
    {
      originCountry: sql.raw('e.origin_country'),
      commodityId: sql.raw('e.commodity_id'),
      destination: sql.raw('e.destination'),
      hazardIds: sql.raw('e.hazard_ids'),
    },
    {
      originCountry: sql.raw('w.origin_country'),
      commodityId: sql.raw('w.commodity_id'),
      destination: sql.raw('w.destination'),
      hazardId: sql.raw('w.hazard_id'),
    },
    sql`(select c.ancestor_ids from commodity c where c.id = e.commodity_id)`,
  );
  return sql`with e as (${eventsBetween(lastId, upTo)})
    insert into alert (id, org_id, change_event_id, firm_id, severity)
    select ${UUIDV7}, m.org_id, m.event_id, m.firm_id, m.severity
    from (
      select distinct on (w.org_id, e.id) w.org_id, e.id as event_id, e.firm_id, e.severity
      from e
      join watchlist_item w on w.kind = 'topic' and ${match}
      order by w.org_id, e.id
    ) m
    where true
    on conflict (org_id, change_event_id) do nothing
    returning id, org_id, severity`;
}

interface InsertedRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  severity: Severity;
}

/**
 * One transaction: lock the cursor, read the next events, stop before the first firm-level event that has no firm
 * yet, insert the alerts for the rest and move the cursor. The alerts and the cursor commit together, so a crash
 * leaves the events unprocessed, and a second run waiting on the lock finds the cursor already moved.
 */
async function processBatch(db: Database, batchSize: number): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    await tx.insert(jobCursor).values({ name: ALERTS_CURSOR }).onConflictDoNothing();
    const [{ lastId }] = await tx.select({ lastId: jobCursor.lastId }).from(jobCursor).where(eq(jobCursor.name, ALERTS_CURSOR)).for('update');

    const events = await tx
      .select({ id: changeEvent.id, requiresFirm: changeEvent.requiresFirm, firmId: changeEvent.firmId, createdAt: changeEvent.createdAt })
      .from(changeEvent)
      .where(gt(changeEvent.id, lastId))
      .orderBy(asc(changeEvent.id))
      .limit(batchSize);

    // Spec §11: the cursor never moves past an event that needs a firm and has none. A later link run fills it in.
    const stop = events.findIndex((event) => event.requiresFirm && event.firmId === null);
    const ready = stop === -1 ? events : events.slice(0, stop);
    const blockedEvent = stop === -1 ? null : events[stop];
    const blocked = blockedEvent ? { eventId: blockedEvent.id, createdAt: blockedEvent.createdAt } : null;
    const done = blocked !== null || events.length < batchSize;
    if (ready.length === 0) return { eventsRead: 0, created: [], cursor: lastId, blocked, done };

    const upTo = ready[ready.length - 1].id;
    const created: NewAlert[] = [];
    for (const statement of [insertFirmAlerts(lastId, upTo), insertTopicAlerts(lastId, upTo)]) {
      const { rows } = await tx.execute<InsertedRow>(statement);
      created.push(...rows.map((row) => ({ id: row.id, orgId: row.org_id, severity: row.severity })));
    }
    await tx.update(jobCursor).set({ lastId: upTo, updatedAt: sql`now()` }).where(eq(jobCursor.name, ALERTS_CURSOR));
    return { eventsRead: ready.length, created, cursor: upTo, blocked, done };
  });
}

interface Recipient {
  userId: string;
  email: string;
  name: string;
  locale: Locale;
  orgIds: Set<string>;
}

const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);

/** Verified members of the active accounts that got high-severity alerts and have not turned instant email off (a user without a `notification_pref` row has it on). */
async function loadRecipients(db: Database, orgIds: string[]): Promise<Recipient[]> {
  if (orgIds.length === 0) return [];
  const rows = await db
    .select({ orgId: membership.orgId, userId: appUser.id, email: appUser.email, name: appUser.name, locale: appUser.locale })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    // A deactivated account is locked out of the app, so its members get no email (their alerts are kept for a reactivation).
    .innerJoin(org, and(eq(org.id, membership.orgId), isNull(org.deactivatedAt)))
    .leftJoin(notificationPref, eq(notificationPref.userId, appUser.id))
    .where(and(inArray(membership.orgId, orgIds), isNotNull(appUser.emailVerifiedAt), sql`coalesce(${notificationPref.instantHigh}, true)`))
    .orderBy(asc(appUser.id));
  const byUser = new Map<string, Recipient>();
  for (const row of rows) {
    const recipient = byUser.get(row.userId) ?? { userId: row.userId, email: row.email, name: row.name, locale: isLocale(row.locale) ? row.locale : 'en', orgIds: new Set<string>() };
    recipient.orgIds.add(row.orgId);
    byUser.set(row.userId, recipient);
  }
  return [...byUser.values()];
}

interface AlertDetail {
  alertId: string;
  orgId: string;
  eventId: number;
  item: AlertEmailItem;
}

/** What an email shows about each alert: the same joins the alerts list uses. */
async function loadDetails(db: Database, alerts: NewAlert[], appOrigin: string): Promise<AlertDetail[]> {
  const details: AlertDetail[] = [];
  for (let i = 0; i < alerts.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        alertId: alert.id,
        orgId: alert.orgId,
        eventId: changeEvent.id,
        kind: changeEvent.kind,
        severity: alert.severity,
        source: changeEvent.source,
        occurredOn: changeEvent.occurredOn,
        destination: changeEvent.destination,
        eventOrigin: changeEvent.originCountry,
        firmName: firm.displayName,
        productText: notice.productText,
        noticeOrigin: notice.originCountry,
      })
      .from(alert)
      .innerJoin(changeEvent, eq(changeEvent.id, alert.changeEventId))
      .leftJoin(firm, eq(firm.id, alert.firmId))
      .leftJoin(notice, eq(notice.id, changeEvent.noticeId))
      .where(
        inArray(
          alert.id,
          alerts.slice(i, i + ID_CHUNK).map((a) => a.id),
        ),
      );
    for (const row of rows) {
      details.push({
        alertId: row.alertId,
        orgId: row.orgId,
        eventId: row.eventId,
        item: {
          kind: row.kind as EventKind,
          severity: row.severity as Severity,
          occurredOn: row.occurredOn,
          firmName: row.firmName,
          productText: row.productText,
          destination: (row.destination ?? NOTICE_DESTINATION[row.source as NoticeSource]) as Destination,
          originCountry: row.eventOrigin ?? row.noticeOrigin,
          url: `${appOrigin}/alerts/${row.alertId}`,
        },
      });
    }
  }
  // Newest event first.
  return details.sort((a, b) => b.eventId - a.eventId);
}

/**
 * One instant email per recipient covering all their high-severity alerts from this run (P5-D13). The `alert_email`
 * rows are written only after the provider took the email: a paused or failed send leaves the alerts for the digest.
 */
async function sendInstantEmails(db: Database, mailer: Mailer, appOrigin: string, high: NewAlert[]): Promise<AlertsRunResult['emails']> {
  const emails = { sent: 0, paused: 0, failed: 0 };
  if (high.length === 0) return emails;
  const [recipients, details] = await Promise.all([loadRecipients(db, [...new Set(high.map((a) => a.orgId))]), loadDetails(db, high, appOrigin)]);

  for (const recipient of recipients) {
    const mine = details.filter((detail) => recipient.orgIds.has(detail.orgId)).slice(0, MAX_EMAIL_ITEMS);
    if (mine.length === 0) continue;
    try {
      const content = renderInstantAlertEmail(recipient.locale, {
        name: recipient.name,
        items: mine.map((detail) => detail.item),
        alertsLink: `${appOrigin}/alerts`,
        settingsLink: `${appOrigin}/settings`,
      });
      const outcome = await mailer.send({ kind: 'instant_alert', to: recipient.email, userId: recipient.userId, content });
      emails[outcome] += 1;
      if (outcome === 'sent') {
        await db
          .insert(alertEmail)
          .values(mine.map((detail) => ({ alertId: detail.alertId, userId: recipient.userId })))
          .onConflictDoNothing();
      }
    } catch (err) {
      // The alerts are committed already; an email that could not be prepared or recorded waits for the digest.
      // The message can carry the address, so only the error's name is printed.
      emails.failed += 1;
      console.error(`alerts:run: an instant email could not be completed (${err instanceof Error ? err.name : 'unknown error'})`);
    }
  }
  return emails;
}

/**
 * Turns the new `change_event` rows into `alert` rows for the accounts that watch them, then sends the instant emails
 * (spec §11). Events are read in id order from the cursor; a firm-level event without a firm stops the cursor, and one
 * that stays unlinked for 48 hours fails the run so the owner hears about it (P5-D14).
 */
export async function runAlerts(deps: AlertsDeps, opts: { batchSize?: number } = {}): Promise<AlertsRunResult> {
  const { db, mailer, appOrigin } = deps;
  const now = deps.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  let eventsRead = 0;
  let cursor = 0;
  let blocked: BatchResult['blocked'] = null;
  const created: NewAlert[] = [];
  for (;;) {
    const batch = await processBatch(db, batchSize);
    eventsRead += batch.eventsRead;
    cursor = batch.cursor;
    blocked = batch.blocked;
    created.push(...batch.created);
    if (batch.done) break;
  }

  const emails = mailer
    ? await sendInstantEmails(db, mailer, appOrigin, created.filter((a) => a.severity === 'high'))
    : { sent: 0, paused: 0, failed: 0 };

  const ageHours = blocked ? (now().getTime() - blocked.createdAt.getTime()) / 3_600_000 : 0;
  return {
    eventsRead,
    alertsCreated: created.length,
    emails,
    cursor,
    blocked: blocked ? { eventId: blocked.eventId, createdAt: blocked.createdAt.toISOString(), ageHours: Math.round(ageHours * 10) / 10 } : null,
    failBlocked: blocked !== null && ageHours >= ALERTS_BLOCKED_FAIL_HOURS,
  };
}
