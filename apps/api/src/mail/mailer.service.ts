import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { type ApiEnv, capTierFor, EMAIL_CAP_TIERS, type EmailKind } from '@rejectradar/contracts';
import { type Database, emailDelivery } from '@rejectradar/db';
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import { MAIL_TRANSPORT, type MailTransport } from './transports';

/** The advisory-lock key of the daily cap check ("MAIL" in ASCII), the same convention as `FIRM_LOCK_KEY`. */
export const EMAIL_CAP_LOCK_KEY = 0x4d41494c;

const ERROR_MAX_LENGTH = 500;
const CAP_REACHED_MESSAGE = 'We can’t send email right now. Try again later.';

type Executor = Pick<Database, 'select'>;

export interface OutgoingEmail {
  kind: EmailKind;
  to: string;
  userId: string | null;
  /** Already rendered: `renderEmail` for the account emails, the alert and digest builders for the rest. */
  content: { subject: string; html: string; text: string };
}

const capReached = () => new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'EMAIL_CAP_REACHED', CAP_REACHED_MESSAGE);

/**
 * The one place email leaves the product (spec §11). Every send is recorded in `email_delivery`, and the daily (UTC)
 * count of `sending` and `sent` rows decides whether it goes out: instant alerts pause at 70, digests at 90, account
 * emails at 100 (which are refused with 503 instead, because a person is waiting for them).
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** Throws `EMAIL_CAP_REACHED` when an account email could not be sent today. Lets a caller refuse before it changes anything. */
  async assertCapacity(kind: EmailKind): Promise<void> {
    if ((await this.sentToday(this.db)) >= EMAIL_CAP_TIERS[capTierFor(kind)]) throw capReached();
  }

  async send(email: OutgoingEmail): Promise<'sent' | 'paused' | 'failed'> {
    const tier = capTierFor(email.kind);
    const id = uuidv7();

    // The lock serialises the count and the insert, so parallel sends cannot all see 99 and all go through.
    // It is held only until commit; the transport is called after, so a slow provider never blocks other senders.
    const paused = await this.db.transaction(async (tx) => {
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
      if (tier === 'account') throw capReached();
      return 'paused';
    }

    try {
      const { providerId } = await this.transport.send({ from: this.env.MAIL_FROM, to: email.to, ...email.content });
      await this.record(id, { status: 'sent', providerId });
      return 'sent';
    } catch (error) {
      // Log the kind and the row, never the address.
      this.logger.warn({ kind: email.kind, deliveryId: id }, 'Email delivery failed');
      await this.record(id, { status: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX_LENGTH) });
      return 'failed';
    }
  }

  private async record(id: string, outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; error: string }): Promise<void> {
    try {
      await this.db
        .update(emailDelivery)
        .set(outcome.status === 'sent' ? { status: 'sent', providerId: outcome.providerId } : { status: 'failed', error: outcome.error })
        .where(eq(emailDelivery.id, id));
    } catch (error) {
      // The email already went out (or already failed); a bookkeeping error must not turn that into a failed request.
      // The row stays `sending`, which still counts against the cap.
      this.logger.error({ err: error, deliveryId: id }, 'Could not record the email outcome');
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
