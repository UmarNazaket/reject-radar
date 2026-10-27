import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Locale, Role } from '@rejectradar/contracts';
import { appUser, type Database, membership, org, refreshToken } from '@rejectradar/db';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../common/errors';
import { DB } from '../../database/database.module';
import { AccessTokenService } from '../access-tokens';
import type { ContextRequest, RequestContext } from '../context';
import { ACCESS_COOKIE } from '../cookies';
import { IS_PUBLIC } from '../decorators';

const invalidSession = () => new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_SESSION', 'Your session has ended. Sign in again.');

/**
 * Signs the caller in from the `rr_at` cookie. The JWT only names the user, account and session; one query then
 * reads the user, membership, account and whether the session is still live, so a role change, removal,
 * deactivation, logout or password reset takes effect on the next request (P4-D3).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    @Inject(DB) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<ContextRequest>();

    const cookie = (req.cookies as Record<string, unknown> | undefined)?.[ACCESS_COOKIE];
    if (typeof cookie !== 'string' || cookie === '') {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Sign in to continue.');
    }
    const claims = this.tokens.verify(cookie);
    if (claims === null) throw invalidSession();

    const [row] = await this.db
      .select({
        role: membership.role,
        locale: appUser.locale,
        verifiedAt: appUser.emailVerifiedAt,
        isPlatformAdmin: appUser.isPlatformAdmin,
        deactivatedAt: org.deactivatedAt,
        live: sql<boolean>`exists (
          select 1 from ${refreshToken}
          where ${refreshToken.familyId} = ${claims.familyId}
            and ${refreshToken.userId} = ${claims.userId}
            and ${refreshToken.revokedAt} is null
        )`,
      })
      .from(appUser)
      .innerJoin(membership, and(eq(membership.orgId, claims.orgId), eq(membership.userId, appUser.id)))
      .innerJoin(org, eq(org.id, membership.orgId))
      .where(eq(appUser.id, claims.userId))
      .limit(1);
    if (!row || !row.live) throw invalidSession();
    if (row.deactivatedAt !== null) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated. Contact support.');
    }

    const ctx: RequestContext = {
      userId: claims.userId,
      orgId: claims.orgId,
      role: row.role as Role,
      locale: row.locale as Locale,
      emailVerified: row.verifiedAt !== null,
      isPlatformAdmin: row.isPlatformAdmin,
      familyId: claims.familyId,
    };
    req.context = ctx;
    return true;
  }
}
