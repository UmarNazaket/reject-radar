import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv, Locale, ResetPasswordRequest, StatusResponse } from '@rejectradar/contracts';
import { appUser, type Database } from '@rejectradar/db';
import { renderEmail } from '@rejectradar/mail';
import { eq, sql } from 'drizzle-orm';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import { MailerService } from '../mail/mailer.service';
import { EmailTokensService } from './email-tokens.service';
import { commonPasswordError, hashPassword, isCommonPassword } from './passwords';
import { SessionsService } from './sessions.service';

/** The same body for a known and an unknown address (no enumeration, spec §12). */
const CHECK_EMAIL: StatusResponse = { status: 'check_email' };

@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly mailer: MailerService,
    private readonly tokens: EmailTokensService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Sends a reset link, which replaces any earlier one. An unknown address gets the same answer and no email. The
   * capacity check comes first for every address, so a full cap answers 503 for all of them and cannot be used to
   * probe for accounts.
   */
  async forgot(email: string): Promise<StatusResponse> {
    await this.mailer.assertCapacity('reset');
    const [user] = await this.db
      .select({ id: appUser.id, name: appUser.name, locale: appUser.locale })
      .from(appUser)
      .where(sql`lower(${appUser.email}) = ${email}`);
    if (!user) return CHECK_EMAIL;

    const token = await this.db.transaction((tx) => this.tokens.issue(tx, user.id, 'reset'));
    await this.mailer.send({
      kind: 'reset',
      to: email,
      userId: user.id,
      content: renderEmail('reset', user.locale as Locale, { name: user.name, link: `${this.env.APP_ORIGIN}/reset?token=${token}` }),
    });
    return CHECK_EMAIL;
  }

  /**
   * Sets a new password with a reset link (P4-D11). A common password is refused before the link is spent, so the
   * person can try again with the same link. A link that is not live is refused before the password is hashed, so junk
   * tokens cost one indexed read rather than an argon2 hash; `consume` re-checks it under lock. Spending the link, the
   * new password, clearing the lockout, verifying the address (a reset proves control of the inbox) and ending every
   * session are one transaction.
   */
  async reset(body: ResetPasswordRequest): Promise<StatusResponse> {
    if (isCommonPassword(body.password)) {
      throw commonPasswordError();
    }
    await this.tokens.assertLive(this.db, body.token, 'reset');
    const passwordHash = await hashPassword(body.password);
    await this.db.transaction(async (tx) => {
      const { userId } = await this.tokens.consume(tx, body.token, 'reset');
      await tx
        .update(appUser)
        .set({
          passwordHash,
          failedLogins: 0,
          lockedUntil: null,
          emailVerifiedAt: sql`coalesce(${appUser.emailVerifiedAt}, now())`,
        })
        .where(eq(appUser.id, userId));
      await this.sessions.revokeAllForUser(tx, userId);
    });
    return { status: 'password_reset' };
  }
}
