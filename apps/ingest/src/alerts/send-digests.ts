import { LOCALES, type Locale } from '@rejectradar/contracts';
import { alert, alertEmail, appUser, type Database, membership, notificationPref, org } from '@rejectradar/db';
import { CATALOGS, translate } from '@rejectradar/i18n';
import { type AlertEmailItem, type Mailer, renderDigestEmail } from '@rejectradar/mail';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, notExists, sql } from 'drizzle-orm';
import { type AlertDetail, loadDetails } from './run-alerts';

/** A digest lists at most this many alerts; the email says how many more are waiting in the account. */
export const DIGEST_MAX_ITEMS = 50;

const DAY_MS = 24 * 3_600_000;
/** `Date.getUTCDay()` of a Monday: weekly digests go out on this day. */
const MONDAY = 1;
/**
 * A digest's window ends this long before the run's clock (R15). `alert.created_at` is the start of the `alerts:run`
 * transaction that inserted it, and that transaction can commit minutes later, after the digest has read its window.
 * Alerts from the last 15 minutes wait for the next digest, so none is ever skipped.
 */
export const DIGEST_WINDOW_LAG_MS = 15 * 60_000;

export interface DigestsDeps {
  db: Database;
  mailer: Mailer;
  /** The web app's origin, for the links in the emails. */
  appOrigin: string;
  now?: () => Date;
}

export interface DigestsResult {
  /** Users whose digest was due in this run. */
  users: number;
  sent: number;
  /** Held back by the daily cap; the same window is tried again on the next run. */
  paused: number;
  failed: number;
  /** Nothing to report: no email, and the window moved on. */
  empty: number;
}

type Frequency = 'daily' | 'weekly';

interface Recipient {
  userId: string;
  email: string;
  name: string;
  locale: Locale;
  frequency: Frequency;
  lastDigestAt: Date | null;
  orgIds: string[];
}

const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);

/**
 * The users whose digest setting is daily or weekly: verified members of an active account (a deactivated account is
 * locked out of the app, so its members get no email, R13). A user without a `notification_pref` row has the default,
 * daily (P5-D13).
 */
async function loadRecipients(db: Database): Promise<Recipient[]> {
  const frequency = sql<Frequency>`coalesce(${notificationPref.digest}, 'daily')`;
  const rows = await db
    .select({
      orgId: membership.orgId,
      userId: appUser.id,
      email: appUser.email,
      name: appUser.name,
      locale: appUser.locale,
      frequency,
      lastDigestAt: notificationPref.lastDigestAt,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .innerJoin(org, and(eq(org.id, membership.orgId), isNull(org.deactivatedAt)))
    .leftJoin(notificationPref, eq(notificationPref.userId, appUser.id))
    .where(and(isNotNull(appUser.emailVerifiedAt), inArray(frequency, ['daily', 'weekly'])))
    .orderBy(asc(appUser.id), asc(membership.orgId));
  const byUser = new Map<string, Recipient>();
  for (const row of rows) {
    const recipient = byUser.get(row.userId) ?? {
      userId: row.userId,
      email: row.email,
      name: row.name,
      locale: isLocale(row.locale) ? row.locale : 'en',
      frequency: row.frequency,
      lastDigestAt: row.lastDigestAt,
      orgIds: [],
    };
    recipient.orgIds.push(row.orgId);
    byUser.set(row.userId, recipient);
  }
  return [...byUser.values()];
}

/** The Monday 00:00 UTC of the week that `now` falls in. */
function mondayStart(now: Date): Date {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfDay - ((now.getUTCDay() + 6) % 7) * DAY_MS);
}

/**
 * Whether the user's digest is due on the day of `now` (R14). Daily: every day. Weekly: on a UTC Monday, and on any
 * other day when the last digest is from before this week's Monday (that Monday's run was paused, failed or did not
 * run), so a missed weekly digest goes out the next day and covers both periods. A weekly user who has never had a
 * digest waits for a Monday.
 */
function isDue(recipient: Recipient, now: Date): boolean {
  if (recipient.frequency === 'daily' || now.getUTCDay() === MONDAY) return true;
  return recipient.lastDigestAt !== null && recipient.lastDigestAt < mondayStart(now);
}

/**
 * The newest `DIGEST_MAX_ITEMS` of the user's accounts' unread alerts created after `start` and up to `now` that were
 * not already emailed to the user, with how many there are in all.
 */
async function loadWindow(db: Database, recipient: Recipient, start: Date, now: Date): Promise<{ ids: { id: string }[]; total: number }> {
  const rows = await db
    .select({ id: alert.id, total: sql<number>`(count(*) over ())::int` })
    .from(alert)
    .where(
      and(
        inArray(alert.orgId, recipient.orgIds),
        isNull(alert.readAt),
        gt(alert.createdAt, start),
        lte(alert.createdAt, now),
        notExists(db.select({ one: sql`1` }).from(alertEmail).where(and(eq(alertEmail.alertId, alert.id), eq(alertEmail.userId, recipient.userId)))),
      ),
    )
    .orderBy(desc(alert.createdAt), desc(alert.changeEventId), asc(alert.id))
    .limit(DIGEST_MAX_ITEMS);
  return { ids: rows.map((row) => ({ id: row.id })), total: rows[0]?.total ?? 0 };
}

const regionNames = new Map<Locale, Intl.DisplayNames>();

/** The country's name in the reader's language; the code itself when the runtime does not know it. */
function countryName(locale: Locale, code: string): string {
  try {
    let names = regionNames.get(locale);
    if (!names) regionNames.set(locale, (names = new Intl.DisplayNames([locale], { type: 'region' })));
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The commodity's name in the reader's language (catalog key `taxonomy.commodity.<slug>`); the stored English name when the catalog has none. */
function commodityLabel(locale: Locale, commodity: { slug: string; name: string }): string {
  const key = `taxonomy.commodity.${commodity.slug}`;
  return key in CATALOGS.en ? translate(locale, key) : commodity.name;
}

interface Group {
  title: string;
  items: AlertEmailItem[];
}

/**
 * Groups the alerts, newest first: the alerts of one firm form one group titled with the firm's name (source data,
 * never translated); the others are grouped by origin and commodity, titled "Pakistan x Rice" in the user's language.
 */
function groupDetails(locale: Locale, details: AlertDetail[]): Group[] {
  const groups = new Map<string, Group>();
  for (const detail of details) {
    let key: string;
    let title: () => string;
    if (detail.firmId !== null && detail.item.firmName) {
      key = `firm:${detail.firmId}`;
      title = () => detail.item.firmName as string;
    } else {
      const origin = detail.item.originCountry;
      key = `topic:${origin ?? ''}:${detail.commodity?.slug ?? ''}`;
      title = () => {
        const parts = [origin ? countryName(locale, origin) : null, detail.commodity ? commodityLabel(locale, detail.commodity) : null].filter(
          (part): part is string => part !== null,
        );
        return parts.length > 0 ? parts.join(' \u00d7 ') : translate(locale, 'email.digest.otherAlerts');
      };
    }
    const group = groups.get(key) ?? { title: title(), items: [] };
    group.items.push(detail.item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Records that the user's digest window ends at `at`; a user without a `notification_pref` row gets one with the defaults. */
async function moveWindow(db: Database, userId: string, at: Date): Promise<void> {
  await db
    .insert(notificationPref)
    .values({ userId, lastDigestAt: at })
    .onConflictDoUpdate({ target: notificationPref.userId, set: { lastDigestAt: at } });
}

type Outcome = 'sent' | 'paused' | 'failed' | 'empty';

/** `end` is the end of this run's window; the next window starts there. */
async function digestFor(deps: DigestsDeps, recipient: Recipient, end: Date): Promise<Outcome> {
  const { db, mailer, appOrigin } = deps;
  const start = recipient.lastDigestAt ?? new Date(end.getTime() - (recipient.frequency === 'weekly' ? 7 : 1) * DAY_MS);
  const { ids, total } = await loadWindow(db, recipient, start, end);
  if (ids.length === 0) {
    await moveWindow(db, recipient.userId, end);
    return 'empty';
  }

  // loadDetails sorts by event; the window's order (newest alert first) is the one the digest keeps.
  const position = new Map(ids.map((row, index) => [row.id, index]));
  const details = (await loadDetails(db, ids, appOrigin)).sort((a, b) => (position.get(a.alertId) ?? 0) - (position.get(b.alertId) ?? 0));
  const content = renderDigestEmail(recipient.locale, {
    name: recipient.name,
    frequency: recipient.frequency,
    groups: groupDetails(recipient.locale, details),
    more: total - details.length,
    alertsLink: `${appOrigin}/alerts`,
    settingsLink: `${appOrigin}/settings`,
  });
  const outcome = await mailer.send({ kind: 'digest', to: recipient.email, userId: recipient.userId, content });
  if (outcome === 'sent') {
    await moveWindow(db, recipient.userId, end);
    return 'sent';
  }
  return outcome;
}

/** The database's clock: `alert.created_at` comes from it, so the window is measured on it. */
async function databaseNow(db: Database): Promise<Date> {
  const { rows } = await db.execute<{ now: Date | string }>(sql`select now() as now`);
  return new Date(rows[0].now);
}

/** What is safe to log about an error: its name and, for a database error, its SQLSTATE code and constraint (never the message, which can carry an address). */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  const { code, constraint } = err as Error & { code?: unknown; constraint?: unknown };
  return [err.name, typeof code === 'string' ? `code ${code}` : null, typeof constraint === 'string' ? `constraint ${constraint}` : null]
    .filter((part): part is string => part !== null)
    .join(', ');
}

/**
 * Sends the daily and weekly digests (spec section 11). For each user with `digest = daily` (every day) or `weekly` (Mondays,
 * UTC) it emails the unread alerts of their accounts created since their last digest, minus those already emailed to
 * them, grouped by firm and topic, in their language. A user with nothing to report gets no email, and the window moves
 * on. The window moves only after the provider took the email, so a paused (cap) or failed digest is sent on the next
 * run and covers both periods (P5-D13); a weekly digest missed on its Monday is due again the next day (R14).
 *
 * The run's clock is the database's (`now()`), or `deps.now` in tests. It decides which day it is (the Monday check, in
 * UTC) and, `DIGEST_WINDOW_LAG_MS` earlier, where the window ends and the next one starts (R15).
 */
export async function sendDigests(deps: DigestsDeps): Promise<DigestsResult> {
  const now = deps.now ? deps.now() : await databaseNow(deps.db);
  const end = new Date(now.getTime() - DIGEST_WINDOW_LAG_MS);
  const recipients = (await loadRecipients(deps.db)).filter((recipient) => isDue(recipient, now));

  const result: DigestsResult = { users: recipients.length, sent: 0, paused: 0, failed: 0, empty: 0 };
  for (const recipient of recipients) {
    try {
      result[await digestFor(deps, recipient, end)] += 1;
    } catch (err) {
      // One user's problem must not stop the others. The message can carry the address, so it is not printed.
      result.failed += 1;
      console.error(`digest:send: a digest could not be completed (${describeError(err)})`);
    }
  }
  return result;
}
