import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DEFAULT_LOCALE, type InviteRole, isLocale, type Locale, type MembersResponse, type Role } from '@rejectradar/contracts';
import { appUser, type Database, invite, membership } from '@rejectradar/db';
import { and, asc, count, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
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

  /** How many people belong to the account; open invites are not counted (they are not seats yet, P5-D3). Takes the caller's transaction when there is one. */
  async count(orgId: string, executor: Database | Tx = this.db): Promise<number> {
    const [row] = await executor.select({ members: count() }).from(membership).where(byOrg(membership, { orgId }));
    return row.members;
  }

  /** The owners of an account whose email address is verified, with the language each reads in. Email about the account goes only to these. */
  async verifiedOwners(orgId: string): Promise<{ userId: string; email: string; locale: Locale }[]> {
    const rows = await this.db
      .select({ userId: appUser.id, email: appUser.email, locale: appUser.locale })
      .from(membership)
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .where(and(eq(membership.orgId, orgId), eq(membership.role, 'owner'), isNotNull(appUser.emailVerifiedAt)))
      .orderBy(asc(membership.createdAt), asc(appUser.id));
    return rows.map((row) => ({ ...row, locale: isLocale(row.locale) ? row.locale : DEFAULT_LOCALE }));
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
      // A fixed order, so two requests locking the same account never wait on each other's rows crosswise.
      .orderBy(asc(membership.userId))
      .for('update');
    return rows as MemberRow[];
  }

  /**
   * Sets a member's role. Only an owner grants `owner` or changes an owner's role (403 for anyone else, whatever the
   * account looks like), and the account always keeps an owner (409). The caller's rights come first, from the role
   * the guard loaded; the owner count follows on the locked rows; the caller's role is then read again under the
   * lock, so a request that waited behind a demotion of its own caller is judged by what the account is now.
   */
  async changeRole(ctx: RequestContext, userId: string, role: Role): Promise<void> {
    await this.db.transaction(async (tx) => {
      const members = await this.lockMembers(tx, ctx.orgId);
      const target = members.find((m) => m.userId === userId);
      if (!target) throw notFound();
      const mayChange = (actor: Role) => actor !== 'member' && (actor === 'owner' || (role !== 'owner' && target.role !== 'owner'));
      if (!mayChange(ctx.role)) throw forbidden();
      if (target.role === 'owner' && role !== 'owner' && ownersOf(members) <= 1) throw lastOwner();
      if (!mayChange(actorOf(members, ctx))) throw forbidden();

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
      const mayRemove = (actor: Role) => actor === 'owner' || (target.role !== 'owner' && (actor === 'admin' || userId === ctx.userId));
      if (!mayRemove(ctx.role)) throw forbidden();
      if (target.role === 'owner' && ownersOf(members) <= 1) throw lastOwner();
      if (!mayRemove(actorOf(members, ctx))) throw forbidden();

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
