import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv, EmailKind } from '@rejectradar/contracts';
import type { Database } from '@rejectradar/db';
import { EmailCapReachedError, Mailer, type MailTransport, type OutgoingEmail } from '@rejectradar/mail';
import { AppError } from '../common/errors';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import { MAIL_TRANSPORT } from './mail-transport';

export type { OutgoingEmail } from '@rejectradar/mail';

const CAP_REACHED_MESSAGE = 'We can’t send email right now. Try again later.';

const capReached = () => new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'EMAIL_CAP_REACHED', CAP_REACHED_MESSAGE);

/**
 * The API's handle on the shared mailer (`@rejectradar/mail`, which the ingest CLI uses too): the same cap and the
 * same `email_delivery` records, with the cap error turned into the API's 503 and failures written to the Nest log.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly mailer: Mailer;

  constructor(
    @Inject(DB) db: Database,
    @Inject(MAIL_TRANSPORT) transport: MailTransport,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.mailer = new Mailer({
      db,
      transport,
      from: env.MAIL_FROM,
      onError: ({ kind, deliveryId, err, stage }) => {
        // Log the kind and the row, never the address (a transport error can contain it).
        if (stage === 'send') this.logger.warn({ kind, deliveryId }, 'Email delivery failed');
        else this.logger.error({ err, deliveryId }, 'Could not record the email outcome');
      },
    });
  }

  /** Throws `EMAIL_CAP_REACHED` when an account email could not be sent today. Lets a caller refuse before it changes anything. */
  async assertCapacity(kind: EmailKind): Promise<void> {
    await this.translateCap(() => this.mailer.assertCapacity(kind));
  }

  /** Emails that count against today's cap, for staff. */
  sentToday(): Promise<number> {
    return this.mailer.sentToday();
  }

  send(email: OutgoingEmail): Promise<'sent' | 'paused' | 'failed'> {
    return this.translateCap(() => this.mailer.send(email));
  }

  private async translateCap<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw error instanceof EmailCapReachedError ? capReached() : error;
    }
  }
}
