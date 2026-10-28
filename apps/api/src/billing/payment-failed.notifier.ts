import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@rejectradar/contracts';
import { type Database, org } from '@rejectradar/db';
import { renderEmail } from '@rejectradar/mail';
import { eq } from 'drizzle-orm';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import { MailerService } from '../mail/mailer.service';
import { MembersService } from '../orgs/members.service';

/**
 * Tells an account's verified owners that its payment failed (P7-D7): one email each, in the owner's language, linking
 * to the billing page. It runs after the webhook transaction has committed and never throws, because Paddle retrying an
 * event that has already been applied would change nothing and a missing email must not hide a stored subscription.
 */
@Injectable()
export class PaymentFailedNotifier {
  private readonly logger = new Logger(PaymentFailedNotifier.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly members: MembersService,
    private readonly mailer: MailerService,
  ) {}

  async notify(orgIds: readonly string[]): Promise<void> {
    for (const orgId of orgIds) {
      try {
        await this.notifyOrg(orgId);
      } catch (error) {
        // The ids are not personal; an error may carry an address, so only its name is logged.
        this.logger.error({ orgId, error: error instanceof Error ? error.name : 'unknown' }, 'Could not look up who to tell about a failed payment');
      }
    }
  }

  private async notifyOrg(orgId: string): Promise<void> {
    const [account] = await this.db.select({ name: org.name }).from(org).where(eq(org.id, orgId));
    if (!account) return;
    const link = `${this.env.APP_ORIGIN}/app/settings/billing`;
    for (const owner of await this.members.verifiedOwners(orgId)) {
      try {
        await this.mailer.send({
          kind: 'payment_failed',
          to: owner.email,
          userId: owner.userId,
          content: renderEmail('payment_failed', owner.locale, { orgName: account.name, link }),
        });
      } catch (error) {
        // Never the address. A reached cap arrives as an `AppError` with `EMAIL_CAP_REACHED`; keep its code, which says why.
        const reason = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : error instanceof Error ? error.name : 'unknown';
        this.logger.warn({ orgId, userId: owner.userId, reason }, 'Payment-failed email was not sent');
      }
    }
  }
}
