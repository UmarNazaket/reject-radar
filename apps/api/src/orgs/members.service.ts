import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { InviteRole, MembersResponse, Role } from '@rejectradar/contracts';
import { appUser, type Database, invite, membership } from '@rejectradar/db';
import { asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { SessionsService } from '../auth/sessions.service';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';
import type { Tx } from '../database/tx';

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'This person is not a member of the account.');
const forbidden = () => new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Your role does not allow this.');
const lastOwner = () => new AppError(HttpStatus.CONFLICT, 'LAST_OWNER', 'An account needs at least one owner. Make someone else an owner first.');
const sessionEnded = () => new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_SESSION', 'Your session has ended. Sign in again.');

interface MemberRow {
  userId: string;
  role: Role;
}

/** Members of the session's account, their roles (P4-D9) and who is still invited. */
@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sessions: SessionsService,
  ) {}

  async list(ctx: RequestContext): Promise<MembersResponse> {
    const members = await this.db
      .select({ userId: membership.userId, name: appUser.name, email: appUser.email, role: membership.role, joinedAt: membership.createdAt })
      .from(membership)
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .where(byOrg(membership, ctx))
      .orderBy(asc(membership.createdAt), asc(membership.userId));
    // Pending means not accepted and not expired, judged on the database clock like every other expiry.
    const invites = await this.db
      .select({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, invitedBy: invite.invitedBy })
      .from(invite)
      .where(byOrg(invite, ctx, isNull(invite.acceptedAt), gt(invite.expiresAt, sql`now()`)))
      .orderBy(asc(invite.createdAt), asc(invite.id));
    return {
      members: members.map((m) => ({ ...m, role: m.role as Role, joinedAt: m.joinedAt.toISOString() })),
      invites: invites.map((i) => ({ ...i, role: i.role as InviteRole, expiresAt: i.expiresAt.toISOString() })),
    };
  }

  /**
   * Locks every membership row of the account until the transaction ends, and returns them. Every role change and
   * removal calls this first and counts owners afterwards, so two owners demoting each other take turns and the second
   * sees the first's result.
   */
  async lockMembers(tx: Tx, orgId: string): Promise<MemberRow[]> {
    const rows = await tx
      .select({ userId: membership.userId, role: membership.role })
      .from(membership)
      .where(byOrg(membership, { orgId }))
      .for('update');
    return rows as MemberRow[];
  }

  /**
   * Sets a member's role. Only an owner grants `owner` or changes an owner's role, and the account always keeps an
   * owner. The invariant is checked before the caller's rights, on the locked rows, and the caller's role is the one
   * read under the lock: a request that waited behind a demotion of its own caller is judged by what the account is now.
   */
  async changeRole(ctx: RequestContext, userId: string, role: Role): Promise<void> {
    await this.db.transaction(async (tx) => {
      const members = await this.lockMembers(tx, ctx.orgId);
      const target = members.find((m) => m.userId === userId);
      if (!target) throw notFound();
      if (target.role === 'owner' && role !== 'owner' && ownersOf(members) <= 1) throw lastOwner();

      const actor = actorOf(members, ctx);
      if (actor === 'member' || (actor !== 'owner' && (role === 'owner' || target.role === 'owner'))) throw forbidden();

      await tx
        .update(membership)
        .set({ role })
        .where(byOrg(membership, ctx, eq(membership.userId, userId)));
    });
  }

  /**
   * Removes a member, or lets one leave. The membership goes and so does every session of the person, in one
   * transaction; their `app_user` row stays (P4-D1).
   */
  async remove(ctx: RequestContext, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const members = await this.lockMembers(tx, ctx.orgId);
      const target = members.find((m) => m.userId === userId);
      if (!target) throw notFound();
      if (target.role === 'owner' && ownersOf(members) <= 1) throw lastOwner();

      const actor = actorOf(members, ctx);
      if (actor !== 'owner' && (target.role === 'owner' || (userId !== ctx.userId && actor === 'member'))) throw forbidden();

      await tx.delete(membership).where(byOrg(membership, ctx, eq(membership.userId, userId)));
      await this.sessions.revokeAllForUser(tx, userId);
    });
  }
}

const ownersOf = (members: MemberRow[]): number => members.filter((m) => m.role === 'owner').length;

/** The caller's role as it is now, under the lock. A caller who has since been removed has no session left. */
function actorOf(members: MemberRow[], ctx: RequestContext): Role {
  const actor = members.find((m) => m.userId === ctx.userId);
  if (!actor) throw sessionEnded();
  return actor.role;
}
