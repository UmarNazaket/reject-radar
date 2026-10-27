import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ApiEnv, Locale, SignupRequest, StatusResponse } from '@rejectradar/contracts';
import { appUser, type Database, membership, org, subscription } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import { MailerService } from '../mail/mailer.service';
import { renderEmail } from '../mail/templates/render';
import { EmailTokensService } from './email-tokens.service';
import { hashPassword, isCommonPassword } from './passwords';

const EMAIL_UNIQUE_INDEX = 'app_user_email_lower_uq';
const CHECK_EMAIL: StatusResponse = { status: 'check_email' };

type Outcome = { created: true; userId: string; token: string } | { created: false };

/** True when `error` (or the error it wraps; Drizzle wraps the driver's) is the unique violation on the email index. */
function isDuplicateEmail(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const { code, constraint, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (code === '23505' && constraint === EMAIL_UNIQUE_INDEX) return true;
    current = cause;
  }
  return false;
}

const byEmail = (email: string) => sql`lower(${appUser.email}) = ${email}`;

@Injectable()
export class SignupService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly mailer: MailerService,
    private readonly tokens: EmailTokensService,
  ) {}

  /**
   * Always answers `check_email`, whether or not the address already has an account (P4-D2, no enumeration). A new
   * address gets a verify email; an existing one gets an account_exists email in that user's language.
   */
  async signup(body: SignupRequest): Promise<StatusResponse> {
    if (isCommonPassword(body.password)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'COMMON_PASSWORD', 'This password is too common. Choose a different one.');
    }
    // Refuse before changing anything, so a person who cannot be emailed is not left with an account.
    await this.mailer.assertCapacity('verify');
    const passwordHash = await hashPassword(body.password);

    const outcome = await this.createAccount(body, passwordHash);
    if (outcome.created) {
      await this.mailer.send({
        kind: 'verify',
        to: body.email,
        userId: outcome.userId,
        content: renderEmail('verify', body.locale, { name: body.name, link: `${this.env.APP_ORIGIN}/verify?token=${outcome.token}` }),
      });
      return CHECK_EMAIL;
    }

    const [existing] = await this.db.select({ id: appUser.id, locale: appUser.locale }).from(appUser).where(byEmail(body.email));
    if (existing) {
      await this.mailer.send({
        kind: 'account_exists',
        to: body.email,
        userId: existing.id,
        content: renderEmail('account_exists', existing.locale as Locale, {
          link: `${this.env.APP_ORIGIN}/login`,
          resetLink: `${this.env.APP_ORIGIN}/forgot`,
        }),
      });
    }
    return CHECK_EMAIL;
  }

  /** Spends the link and marks the email verified; the first verification time is kept. */
  async verifyEmail(token: string): Promise<StatusResponse> {
    await this.db.transaction(async (tx) => {
      const { userId } = await this.tokens.consume(tx, token, 'verify');
      await tx
        .update(appUser)
        .set({ emailVerifiedAt: sql`coalesce(${appUser.emailVerifiedAt}, now())` })
        .where(eq(appUser.id, userId));
    });
    return { status: 'verified' };
  }

  /**
   * Sends a fresh verify link, which replaces the earlier ones. An unknown or already verified address gets the same
   * answer and no email. The capacity check comes first for every address, so the cap cannot be used to probe for accounts.
   */
  async resendVerification(email: string): Promise<StatusResponse> {
    await this.mailer.assertCapacity('verify');
    const [user] = await this.db
      .select({ id: appUser.id, name: appUser.name, locale: appUser.locale, verifiedAt: appUser.emailVerifiedAt })
      .from(appUser)
      .where(byEmail(email));
    if (!user || user.verifiedAt !== null) return CHECK_EMAIL;

    const token = await this.db.transaction((tx) => this.tokens.issue(tx, user.id, 'verify'));
    await this.mailer.send({
      kind: 'verify',
      to: email,
      userId: user.id,
      content: renderEmail('verify', user.locale as Locale, { name: user.name, link: `${this.env.APP_ORIGIN}/verify?token=${token}` }),
    });
    return CHECK_EMAIL;
  }

  /** One transaction for the whole account, or none: a duplicate email (found first, or lost in a race) writes nothing. */
  private async createAccount(body: SignupRequest, passwordHash: string): Promise<Outcome> {
    try {
      return await this.db.transaction(async (tx): Promise<Outcome> => {
        const [existing] = await tx.select({ id: appUser.id }).from(appUser).where(byEmail(body.email));
        if (existing) return { created: false };

        const orgId = uuidv7();
        const userId = uuidv7();
        await tx.insert(org).values({ id: orgId, name: body.companyName });
        await tx.insert(appUser).values({ id: userId, email: body.email, passwordHash, name: body.name, locale: body.locale });
        await tx.insert(membership).values({ orgId, userId, role: 'owner' });
        await tx.insert(subscription).values({ orgId, plan: 'free', status: 'active' });
        return { created: true, userId, token: await this.tokens.issue(tx, userId, 'verify') };
      });
    } catch (error) {
      // A parallel sign-up won the unique index between our check and our insert: that is "exists", not a failure.
      if (isDuplicateEmail(error)) return { created: false };
      throw error;
    }
  }
}
