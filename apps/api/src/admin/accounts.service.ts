import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type AdminOrgQuery,
  type AdminOrgResponse,
  type AdminOrgsResponse,
  AUDIT_PAGE_SIZE,
  type AuditQuery,
  type AuditResponse,
  type BillingInterval,
  type PlanId,
  type PlanOverrideRequest,
  type Role,
  type SubscriptionStatus,
} from '@rejectradar/contracts';
import { appUser, auditLog, type Database, membership, org, subscription } from '@rejectradar/db';
import { and, asc, desc, eq, exists, ilike, like, lt, or, sql } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { InvitesService } from '../orgs/invites.service';
import { MembersService } from '../orgs/members.service';
import { WatchlistsService } from '../watchlists/watchlists.service';

const LIST_LIMIT = 50;

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');
const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');

/** Accounts for staff (P10): find one, see its plan, usage and members, grant or clear a plan override; and the audit log. */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
    private readonly members: MembersService,
    private readonly invites: InvitesService,
    private readonly watchlists: WatchlistsService,
  ) {}

  async list(query: AdminOrgQuery): Promise<AdminOrgsResponse> {
    const pattern = query.q === undefined ? null : `%${escapeLike(query.q)}%`;
    const memberEmail = (p: string) =>
      exists(
        this.db
          .select({ one: sql`1` })
          .from(membership)
          .innerJoin(appUser, eq(appUser.id, membership.userId))
          .where(and(eq(membership.orgId, org.id), ilike(appUser.email, p))),
      );
    const rows = await this.db
      .select({
        id: org.id,
        name: org.name,
        createdAt: org.createdAt,
        deactivatedAt: org.deactivatedAt,
        members: sql<number>`(select count(*)::int from membership m where m.org_id = ${org.id})`,
      })
      .from(org)
      .where(pattern === null ? undefined : or(ilike(org.name, pattern), memberEmail(pattern)))
      .orderBy(desc(org.createdAt), desc(org.id))
      .limit(LIST_LIMIT);
    const plans = await Promise.all(rows.map((row) => this.entitlements.resolvePlan(row.id)));
    return {
      items: rows.map((row, i) => ({
        ...row,
        plan: plans[i].plan,
        source: plans[i].source,
        createdAt: row.createdAt.toISOString(),
        deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
      })),
    };
  }

  async detail(id: string): Promise<AdminOrgResponse> {
    const [account] = await this.db.select().from(org).where(eq(org.id, id));
    if (!account) throw notFound();
    const [{ plan, source, limits }, usage, watchlist, memberCount, seats, [paddle], people] = await Promise.all([
      this.entitlements.resolvePlan(id),
      this.entitlements.usage(id),
      this.watchlists.count(id),
      this.members.count(id),
      this.invites.seats(id),
      this.db.select().from(subscription).where(eq(subscription.orgId, id)),
      this.db
        .select({ userId: membership.userId, name: appUser.name, email: appUser.email, role: membership.role, verifiedAt: appUser.emailVerifiedAt, joinedAt: membership.createdAt })
        .from(membership)
        .innerJoin(appUser, eq(appUser.id, membership.userId))
        .where(eq(membership.orgId, id))
        .orderBy(asc(membership.createdAt), asc(membership.userId)),
    ]);
    return {
      org: {
        id: account.id,
        name: account.name,
        createdAt: account.createdAt.toISOString(),
        planOverride: account.planOverride as PlanId | null,
        deactivatedAt: account.deactivatedAt?.toISOString() ?? null,
      },
      plan,
      source,
      limits,
      usage: { ...usage, watchlist, members: memberCount, seats },
      // Sign-up leaves a free row without Paddle ids, which says nothing about billing.
      subscription: paddle?.paddleSubscriptionId
        ? {
            status: paddle.status as SubscriptionStatus,
            interval: paddle.interval as BillingInterval | null,
            currentPeriodEnd: paddle.currentPeriodEnd?.toISOString() ?? null,
            cancelAt: paddle.cancelAt?.toISOString() ?? null,
          }
        : null,
      members: people.map(({ verifiedAt, ...m }) => ({ ...m, role: m.role as Role, emailVerified: verifiedAt !== null, joinedAt: m.joinedAt.toISOString() })),
    };
  }

  async setPlanOverride(ctx: RequestContext, id: string, body: PlanOverrideRequest): Promise<AdminOrgResponse> {
    await this.db.transaction(async (tx) => {
      const [account] = await tx.select({ planOverride: org.planOverride }).from(org).where(eq(org.id, id)).for('update');
      if (!account) throw notFound();
      await tx.update(org).set({ planOverride: body.planOverride }).where(eq(org.id, id));
      await tx.insert(auditLog).values({
        actorUserId: ctx.userId,
        action: 'org.plan_override',
        targetType: 'org',
        targetId: id,
        details: { before: account.planOverride, after: body.planOverride },
      });
    });
    return this.detail(id);
  }

  /**
   * Deactivates or reactivates an account, audited as `org.deactivate` or `org.reactivate`. A deactivated account's
   * sessions and API keys are refused and its members get no alert emails; its data stays for a reactivation.
   */
  async setActive(ctx: RequestContext, id: string, active: boolean): Promise<AdminOrgResponse> {
    // Staff would lock themselves out of the admin area.
    if (!active && id === ctx.orgId) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'You cannot deactivate your own account.');
    await this.db.transaction(async (tx) => {
      const [account] = await tx.select({ deactivatedAt: org.deactivatedAt }).from(org).where(eq(org.id, id)).for('update');
      if (!account) throw notFound();
      if ((account.deactivatedAt === null) === active) {
        throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', active ? 'This account is active already.' : 'This account is deactivated already.');
      }
      await tx.update(org).set({ deactivatedAt: active ? null : sql`now()` }).where(eq(org.id, id));
      await tx.insert(auditLog).values({ actorUserId: ctx.userId, action: active ? 'org.reactivate' : 'org.deactivate', targetType: 'org', targetId: id });
    });
    return this.detail(id);
  }

  async audit(query: AuditQuery): Promise<AuditResponse> {
    const rows = await this.db
      .select({
        id: auditLog.id,
        at: auditLog.createdAt,
        name: appUser.name,
        email: appUser.email,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        details: auditLog.details,
      })
      .from(auditLog)
      .leftJoin(appUser, eq(appUser.id, auditLog.actorUserId))
      .where(
        and(
          query.action === undefined ? undefined : like(auditLog.action, `${escapeLike(query.action)}%`),
          query.cursor === undefined ? undefined : lt(auditLog.id, query.cursor),
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(AUDIT_PAGE_SIZE + 1);
    const page = rows.slice(0, AUDIT_PAGE_SIZE);
    return {
      items: page.map(({ name, email, at, details, ...row }) => ({
        ...row,
        at: at.toISOString(),
        actor: name !== null && email !== null ? { name, email } : null,
        details: details as Record<string, unknown>,
      })),
      next: rows.length > AUDIT_PAGE_SIZE ? page[page.length - 1].id : null,
    };
  }
}
