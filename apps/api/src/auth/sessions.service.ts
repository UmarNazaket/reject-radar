import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { MeResponse } from '@rejectradar/contracts';
import { appUser, type Database, membership, org, refreshToken } from '@rejectradar/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { randomToken, sha256Hex } from '../common/tokens';
import { DB } from '../database/database.module';
import type { Tx } from '../database/tx';
import { loadMe } from '../orgs/me.queries';
import { AccessTokenService } from './access-tokens';
import { REFRESH_TOKEN_TTL_SEC } from './cookies';
import { DUMMY_PASSWORD_HASH, verifyPassword } from './passwords';

/** Failures that lock an account, and for how long (spec 12). */
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
/** A token replaced less than this long ago is a second tab racing the first, not a thief (P4-D4). */
const REFRESH_GRACE_SEC = 10;

const CREDENTIALS_MESSAGE = 'Email or password is incorrect. After 5 failed attempts, sign-in is paused for 15 minutes.';

const invalidCredentials = () => new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', CREDENTIALS_MESSAGE);
const invalidSession = () => new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_SESSION', 'Your session has ended. Sign in again.');
const refreshRace = () =>
  new AppError(HttpStatus.UNAUTHORIZED, 'REFRESH_RACE', 'This session was refreshed a moment ago. Retry the request.');

export interface SessionTokens {
  access: string;
  refresh: string;
}

type RefreshOutcome = ({ kind: 'ok' } & SessionTokens) | { kind: 'invalid' } | { kind: 'race' };

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /**
   * Checks the password and opens a session. Every 401 path runs one argon2 verify (an unknown email and a locked
   * account verify too), so none of them can be told apart by timing. A missing membership or a deactivated account
   * answers 403 only after the right password, so neither reveals that an address exists.
   */
  async login(email: string, password: string): Promise<{ me: MeResponse } & SessionTokens> {
    const [user] = await this.db
      .select({
        id: appUser.id,
        passwordHash: appUser.passwordHash,
        locked: sql<boolean>`coalesce(${appUser.lockedUntil} > now(), false)`,
      })
      .from(appUser)
      .where(sql`lower(${appUser.email}) = ${email.trim().toLowerCase()}`);

    if (!user) {
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
      throw invalidCredentials();
    }
    const matches = await verifyPassword(user.passwordHash, password);
    if (user.locked) throw invalidCredentials();
    if (!matches) {
      await this.recordFailure(user.id);
      throw invalidCredentials();
    }

    await this.db
      .update(appUser)
      .set({ failedLogins: 0, lockedUntil: null })
      .where(and(eq(appUser.id, user.id), sql`(${appUser.failedLogins} <> 0 or ${appUser.lockedUntil} is not null)`));

    const account = await this.findAccount(this.db, user.id);
    if (!account) throw new AppError(HttpStatus.FORBIDDEN, 'NO_MEMBERSHIP', 'This user does not belong to an account.');
    if (account.deactivated) throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated.');

    return this.db.transaction(async (tx) => {
      const tokens = await this.startSession(tx, user.id, account.orgId);
      return { me: await loadMe(tx, user.id), ...tokens };
    });
  }

  /**
   * Swaps a refresh token for a new pair in the same family. The row is locked, so two requests with one cookie take
   * turns: the second finds the token already replaced. The outcome is returned, not thrown, from the transaction,
   * because revoking a family must commit even though the request fails.
   */
  async refresh(raw: string): Promise<SessionTokens> {
    const outcome = await this.db.transaction(async (tx): Promise<RefreshOutcome> => {
      const [row] = await tx
        .select({
          id: refreshToken.id,
          userId: refreshToken.userId,
          familyId: refreshToken.familyId,
          replacedBy: refreshToken.replacedBy,
          revoked: sql<boolean>`${refreshToken.revokedAt} is not null`,
          expired: sql<boolean>`${refreshToken.expiresAt} <= now()`,
          recent: sql<boolean>`coalesce(${refreshToken.revokedAt} > now() - make_interval(secs => ${REFRESH_GRACE_SEC}), false)`,
        })
        .from(refreshToken)
        .where(eq(refreshToken.tokenHash, sha256Hex(raw)))
        .for('update');

      if (!row || row.expired) return { kind: 'invalid' };
      if (row.revoked) {
        if (row.replacedBy === null) return { kind: 'invalid' };
        if (row.recent) return { kind: 'race' };
        await this.revokeFamily(tx, row.familyId);
        this.logger.warn({ userId: row.userId, familyId: row.familyId }, 'Refresh token reuse');
        return { kind: 'invalid' };
      }

      const account = await this.findAccount(tx, row.userId);
      if (!account || account.deactivated) {
        await this.revokeFamily(tx, row.familyId);
        return { kind: 'invalid' };
      }

      const next = await this.insertRefreshToken(tx, row.userId, row.familyId);
      await tx.update(refreshToken).set({ revokedAt: sql`now()`, replacedBy: next.id }).where(eq(refreshToken.id, row.id));
      return {
        kind: 'ok',
        access: this.accessTokens.sign({ userId: row.userId, orgId: account.orgId, familyId: row.familyId }),
        refresh: next.raw,
      };
    });

    if (outcome.kind === 'race') throw refreshRace();
    if (outcome.kind === 'invalid') throw invalidSession();
    return { access: outcome.access, refresh: outcome.refresh };
  }

  /** Ends the session the token belongs to, every token of its family. An absent or unknown token is not an error. */
  async logout(raw: string | undefined): Promise<void> {
    if (!raw) return;
    await this.db.transaction(async (tx) => {
      // Lock the presented row first, so a refresh in flight finishes (and inserts its new row) before the family is revoked.
      const [row] = await tx
        .select({ familyId: refreshToken.familyId })
        .from(refreshToken)
        .where(eq(refreshToken.tokenHash, sha256Hex(raw)))
        .for('update');
      if (row) await this.revokeFamily(tx, row.familyId);
    });
  }

  /** Opens a new family with its first refresh token, and the access token that names the family. */
  async startSession(tx: Tx, userId: string, orgId: string): Promise<SessionTokens> {
    const familyId = uuidv7();
    const { raw } = await this.insertRefreshToken(tx, userId, familyId);
    return { access: this.accessTokens.sign({ userId, orgId, familyId }), refresh: raw };
  }

  /** Ends every session of a user: a password reset or a removal (Tasks 8 and 9). Their access tokens stop at the next request. */
  async revokeAllForUser(tx: Tx, userId: string): Promise<void> {
    await tx
      .update(refreshToken)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshToken.userId, userId), isNull(refreshToken.revokedAt)));
  }

  private async insertRefreshToken(tx: Tx, userId: string, familyId: string): Promise<{ id: string; raw: string }> {
    const id = uuidv7();
    const raw = randomToken();
    await tx.insert(refreshToken).values({
      id,
      userId,
      familyId,
      tokenHash: sha256Hex(raw),
      expiresAt: sql`now() + make_interval(secs => ${REFRESH_TOKEN_TTL_SEC})`,
    });
    return { id, raw };
  }

  private async revokeFamily(tx: Tx, familyId: string): Promise<void> {
    await tx
      .update(refreshToken)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshToken.familyId, familyId), isNull(refreshToken.revokedAt)));
  }

  /**
   * One atomic statement, so parallel wrong passwords cannot lose a count: the fifth failure locks the account for
   * 15 minutes and starts the count again.
   */
  private async recordFailure(userId: string): Promise<void> {
    const reached = sql`${appUser.failedLogins} + 1 >= ${MAX_FAILED_LOGINS}`;
    await this.db
      .update(appUser)
      .set({
        failedLogins: sql`case when ${reached} then 0 else ${appUser.failedLogins} + 1 end`,
        lockedUntil: sql`case when ${reached} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${appUser.lockedUntil} end`,
      })
      .where(eq(appUser.id, userId));
  }

  private async findAccount(db: Database | Tx, userId: string): Promise<{ orgId: string; deactivated: boolean } | undefined> {
    const [row] = await db
      .select({ orgId: membership.orgId, deactivated: sql<boolean>`${org.deactivatedAt} is not null` })
      .from(membership)
      .innerJoin(org, eq(org.id, membership.orgId))
      .where(eq(membership.userId, userId))
      .limit(1);
    return row;
  }
}
