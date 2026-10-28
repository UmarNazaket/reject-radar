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
 * The users whose digest is due: verified members of an active account (a deactivated account is locked out of the
 * app, so its members get no email, R13) whose digest setting is daily, or weekly on a Monday. A user without a
 * `notification_pref` row has the default, daily (P5-D13).
 */
async function loadRecipients(db: Database, due: Frequency[]): Promise<Recipient[]> {
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
    .where(and(isNotNull(appUser.emailVerifiedAt), inArray(frequency, due)))
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

async function digestFor(deps: DigestsDeps, recipient: Recipient, now: Date): Promise<Outcome> {
  const { db, mailer, appOrigin } = deps;
  const start = recipient.lastDigestAt ?? new Date(now.getTime() - (recipient.frequency === 'weekly' ? 7 : 1) * DAY_MS);
  const { ids, total } = await loadWindow(db, recipient, start, now);
  if (ids.length === 0) {
    await moveWindow(db, recipient.userId, now);
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
    await moveWindow(db, recipient.userId, now);
    return 'sent';
  }
  return outcome;
}

/**
 * Sends the daily and weekly digests (spec section 11). For each user with `digest = daily` (every day) or `weekly` (Mondays,
 * UTC) it emails the unread alerts of their accounts created since their last digest, minus those already emailed to
 * them, grouped by firm and topic, in their language. A user with nothing to report gets no email, and the window moves
 * on. The window moves only after the provider took the email, so a paused (cap) or failed digest is sent on the next
 * run and covers both periods (P5-D13).
 */
export async function sendDigests(deps: DigestsDeps): Promise<DigestsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const due: Frequency[] = now.getUTCDay() === MONDAY ? ['daily', 'weekly'] : ['daily'];
  const recipients = await loadRecipients(deps.db, due);

  const result: DigestsResult = { users: recipients.length, sent: 0, paused: 0, failed: 0, empty: 0 };
  for (const recipient of recipients) {
    try {
      result[await digestFor(deps, recipient, now)] += 1;
    } catch (err) {
      // One user's problem must not stop the others. The message can carry the address, so only the error's name is printed.
      result.failed += 1;
      console.error(`digest:send: a digest could not be completed (${err instanceof Error ? err.name : 'unknown error'})`);
    }
  }
  return result;
}
