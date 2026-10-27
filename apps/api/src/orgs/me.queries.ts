import { HttpStatus } from '@nestjs/common';
import type { MeResponse, Role } from '@rejectradar/contracts';
import { appUser, type Database, membership, org } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import type { Tx } from '../database/tx';

/**
 * The user, their account and their role in it (P4-D1). `NO_MEMBERSHIP` when the user has no account.
 * Pass the request context on an authenticated route: the membership is then the one in the session's account,
 * not whichever the database returns first. Login and sign-up have no context yet and pass none.
 */
export async function loadMe(db: Database | Tx, userId: string, scope?: RequestContext): Promise<MeResponse> {
  const [row] = await db
    .select({
      id: appUser.id,
      email: appUser.email,
      name: appUser.name,
      locale: appUser.locale,
      verifiedAt: appUser.emailVerifiedAt,
      isPlatformAdmin: appUser.isPlatformAdmin,
      orgId: org.id,
      orgName: org.name,
      role: membership.role,
    })
    .from(appUser)
    .innerJoin(membership, eq(membership.userId, appUser.id))
    .innerJoin(org, eq(org.id, membership.orgId))
    .where(scope ? byOrg(membership, scope, eq(appUser.id, userId)) : eq(appUser.id, userId))
    .limit(1);
  if (!row) throw new AppError(HttpStatus.FORBIDDEN, 'NO_MEMBERSHIP', 'This user does not belong to an account.');
  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      locale: row.locale as MeResponse['user']['locale'],
      emailVerified: row.verifiedAt !== null,
      isPlatformAdmin: row.isPlatformAdmin,
    },
    org: { id: row.orgId, name: row.orgName },
    role: row.role as Role,
  };
}
