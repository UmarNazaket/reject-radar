import { HttpStatus, Injectable } from '@nestjs/common';
import type { EmailTokenPurpose } from '@rejectradar/contracts';
import { emailToken } from '@rejectradar/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { randomToken, sha256Hex } from '../common/tokens';
import type { Tx } from '../database/tx';

const HOUR_SEC = 3600;
/** Verification links last 24 hours, reset links 1 hour (spec §12). */
const LIFETIME_SEC: Readonly<Record<EmailTokenPurpose, number>> = { verify: 24 * HOUR_SEC, reset: HOUR_SEC };

const invalidToken = () => new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TOKEN', 'This link is invalid or has expired.');

/** Single-use links sent by email. Only the SHA-256 of a token is stored, so a database read never yields a usable link. */
@Injectable()
export class EmailTokensService {
  /**
   * Makes a new token for the user and marks their earlier unused tokens of that purpose used. Returns the raw token.
   * The user row is locked first: two parallel calls take turns, so the second one sees the first one's committed
   * token and invalidates it, and exactly one token stays live. The expiry uses the database clock, like `consume`.
   */
  async issue(tx: Tx, userId: string, purpose: EmailTokenPurpose): Promise<string> {
    await tx.execute(sql`select 1 from app_user where id = ${userId} for update`);
    await tx
      .update(emailToken)
      .set({ usedAt: sql`now()` })
      .where(and(eq(emailToken.userId, userId), eq(emailToken.purpose, purpose), isNull(emailToken.usedAt)));
    const raw = randomToken();
    await tx.insert(emailToken).values({
      id: uuidv7(),
      userId,
      purpose,
      tokenHash: sha256Hex(raw),
      expiresAt: sql`now() + make_interval(secs => ${LIFETIME_SEC[purpose]})`,
    });
    return raw;
  }

  /**
   * Spends a token. The row is locked, so two requests with the same link cannot both succeed; the loser waits,
   * then sees it used. A missing, used or expired token is `INVALID_TOKEN`, with the same message for all three.
   */
  async consume(tx: Tx, raw: string, purpose: EmailTokenPurpose): Promise<{ userId: string }> {
    const [row] = await tx
      .select({ id: emailToken.id, userId: emailToken.userId, usedAt: emailToken.usedAt, expired: sql<boolean>`${emailToken.expiresAt} <= now()` })
      .from(emailToken)
      .where(and(eq(emailToken.tokenHash, sha256Hex(raw)), eq(emailToken.purpose, purpose)))
      .for('update');
    if (!row || row.usedAt !== null || row.expired) throw invalidToken();
    await tx.update(emailToken).set({ usedAt: sql`now()` }).where(eq(emailToken.id, row.id));
    return { userId: row.userId };
  }
}
