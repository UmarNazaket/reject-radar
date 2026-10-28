import { capTierFor, EMAIL_CAP_TIERS, type EmailKind } from '@rejectradar/contracts';
import { type Database, emailDelivery, uuidv7 } from '@rejectradar/db';
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import type { MailTransport } from './transports';

/** The advisory-lock key of the daily cap check ("MAIL" in ASCII), the same convention as `FIRM_LOCK_KEY`. */
export const EMAIL_CAP_LOCK_KEY = 0x4d41494c;

const ERROR_MAX_LENGTH = 500;

type Executor = Pick<Database, 'select'>;

export interface OutgoingEmail {
  kind: EmailKind;
  to: string;
  userId: string | null;
  /** Already rendered: `renderEmail` for the account emails, the alert and digest renderers for the rest. */
  content: { subject: string; html: string; text: string };
}

/** An account email could not be sent today because the daily cap is used up. */
export class EmailCapReachedError extends Error {
  constructor() {
    super('The daily email cap has been reached');
    this.name = 'EmailCapReachedError';
  }
}

export interface MailerDeps {
  db: Database;
  transport: MailTransport;
  /** The From header of every email. */
  from: string;
  /**
   * Called when a send fails (`stage: 'send'`, the email did not go out) or when its outcome could not be recorded
   * (`stage: 'record'`, the row stays `sending`). `err` may contain the address, so a logger must not print it.
   */
  onError?: (info: { kind: EmailKind; deliveryId: string; err: unknown; stage: 'send' | 'record' }) => void;
}

/**
 * The one place email leaves the product (spec §11). Every send is recorded in `email_delivery`, and the daily (UTC)
 * count of `sending` and `sent` rows decides whether it goes out: instant alerts pause at 70, digests at 90, account
 * emails at 100 (which throw `EmailCapReachedError` instead, because a person is waiting for them).
 */
export class Mailer {
  constructor(private readonly deps: MailerDeps) {}

  /** Throws `EmailCapReachedError` when an account email could not be sent today. Lets a caller refuse before it changes anything. */
  async assertCapacity(kind: EmailKind): Promise<void> {
    if ((await this.sentToday(this.deps.db)) >= EMAIL_CAP_TIERS[capTierFor(kind)]) throw new EmailCapReachedError();
  }

  async send(email: OutgoingEmail): Promise<'sent' | 'paused' | 'failed'> {
    const { db, transport, from } = this.deps;
    const tier = capTierFor(email.kind);
    const id = uuidv7();

    // The lock serialises the count and the insert, so parallel sends cannot all see 99 and all go through.
    // It is held only until commit; the transport is called after, so a slow provider never blocks other senders.
    const paused = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${EMAIL_CAP_LOCK_KEY}::bigint)`);
      const atCap = (await this.sentToday(tx)) >= EMAIL_CAP_TIERS[tier];
      await tx.insert(emailDelivery).values({
        id,
        userId: email.userId,
        toEmail: email.to,
        kind: email.kind,
        status: atCap ? 'paused' : 'sending',
      });
      return atCap;
    });

    if (paused) {
      if (tier === 'account') throw new EmailCapReachedError();
      return 'paused';
    }

    try {
      const { providerId } = await transport.send({ from, to: email.to, ...email.content });
      await this.record(email.kind, id, { status: 'sent', providerId });
      return 'sent';
    } catch (err) {
      this.deps.onError?.({ kind: email.kind, deliveryId: id, err, stage: 'send' });
      await this.record(email.kind, id, { status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX_LENGTH) });
      return 'failed';
    }
  }

  private async record(
    kind: EmailKind,
    id: string,
    outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; error: string },
  ): Promise<void> {
    try {
      await this.deps.db
        .update(emailDelivery)
        .set(outcome.status === 'sent' ? { status: 'sent', providerId: outcome.providerId } : { status: 'failed', error: outcome.error })
        .where(eq(emailDelivery.id, id));
    } catch (err) {
      // The email already went out (or already failed); a bookkeeping error must not turn that into a failed request.
      // The row stays `sending`, which still counts against the cap.
      this.deps.onError?.({ kind, deliveryId: id, err, stage: 'record' });
    }
  }

  /** Rows that count against today's cap: sending or sent since midnight UTC. */
  private async sentToday(executor: Executor): Promise<number> {
    const [row] = await executor
      .select({ n: count() })
      .from(emailDelivery)
      .where(
        and(
          inArray(emailDelivery.status, ['sending', 'sent']),
          gte(emailDelivery.createdAt, sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`),
        ),
      );
    return row.n;
  }
}
