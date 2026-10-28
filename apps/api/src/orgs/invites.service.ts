import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  AcceptInviteRequest,
  ApiEnv,
  CreateInviteRequest,
  InvitePreviewResponse,
  InviteResponse,
  InviteRole,
  Locale,
  MeResponse,
} from '@rejectradar/contracts';
import { appUser, type Database, invite, membership, org } from '@rejectradar/db';
import { renderEmail } from '@rejectradar/mail';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { commonPasswordError, hashPassword, isCommonPassword, verifyPassword } from '../auth/passwords';
import { invalidCredentials, type SessionTokens, SessionsService } from '../auth/sessions.service';
import { isDuplicateEmail } from '../auth/signup.service';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { randomToken, sha256Hex } from '../common/tokens';
import { API_ENV } from '../config/env';
import { DB } from '../database/database.module';
import type { Tx } from '../database/tx';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { MailerService } from '../mail/mailer.service';
import { loadMe } from './me.queries';

/** How long an invite link works (P4-D8), counted on the database clock. */
const INVITE_DAYS = 7;

const invalidToken = () => new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TOKEN', 'This link is invalid or has expired.');
const alreadyInAccount = () =>
  new AppError(HttpStatus.CONFLICT, 'ALREADY_IN_ACCOUNT', 'This person already belongs to an account. Leave it before joining another.');

const byEmail = (email: string) => sql`lower(${appUser.email}) = ${email}`;
/** An invite is open until it is accepted or `expires_at` passes. */
const isOpen = sql`${invite.acceptedAt} is null and ${invite.expiresAt} > now()`;

type AcceptOutcome = ({ kind: 'ok'; me: MeResponse } & SessionTokens) | { kind: 'wrong_password'; userId: string } | { kind: 'locked' };

@Injectable()
export class InvitesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly mailer: MailerService,
    private readonly sessions: SessionsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Invites an email address into the caller's account. The invite for the same address that is still pending is
   * replaced, so only the newest link works. The email goes out in the inviter's language, after the invite commits.
   */
  async create(ctx: RequestContext, body: CreateInviteRequest): Promise<InviteResponse> {
    // Refuse before changing anything, so an invite nobody can be told about is not left behind.
    await this.mailer.assertCapacity('invite');
    const [inviter] = await this.db.select({ name: appUser.name }).from(appUser).where(eq(appUser.id, ctx.userId));
    const [account] = await this.db.select({ name: org.name }).from(org).where(eq(org.id, ctx.orgId));

    const token = randomToken();
    const created = await this.db.transaction(async (tx) => {
      // Two invites for one address at once take turns, so the second replaces the first instead of sitting beside it.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`invite:${ctx.orgId}:${body.email}`}, 0))`);

      const [existing] = await tx
        .select({ userId: membership.userId })
        .from(membership)
        .innerJoin(appUser, eq(appUser.id, membership.userId))
        .where(byOrg(membership, ctx, byEmail(body.email)));
      if (existing) throw new AppError(HttpStatus.CONFLICT, 'ALREADY_MEMBER', 'This person is already a member of the account.');

      // The pending invite for this address is about to be replaced, so it is locked before the seat count (accepting
      // locks the invite first too, and the two must not wait on each other), and it is left out of the count.
      await tx.select({ id: invite.id }).from(invite).where(byOrg(invite, ctx, sql`lower(${invite.email}) = ${body.email}`, isNull(invite.acceptedAt))).for('update');
      await this.lockSeats(tx, ctx.orgId);
      const [{ members }] = await tx.select({ members: count() }).from(membership).where(byOrg(membership, ctx));
      const [{ others }] = await tx
        .select({ others: count() })
        .from(invite)
        .where(byOrg(invite, ctx, isOpen, sql`lower(${invite.email}) <> ${body.email}`));
      await this.entitlements.assertCount(ctx.orgId, 'members', members + others, tx);

      await tx.delete(invite).where(byOrg(invite, ctx, sql`lower(${invite.email}) = ${body.email}`, isNull(invite.acceptedAt)));
      const [row] = await tx
        .insert(invite)
        .values({
          id: uuidv7(),
          orgId: ctx.orgId,
          email: body.email,
          role: body.role,
          tokenHash: sha256Hex(token),
          invitedBy: ctx.userId,
          expiresAt: sql`now() + make_interval(days => ${INVITE_DAYS})`,
        })
        .returning({ id: invite.id, expiresAt: invite.expiresAt });
      return row;
    });

    await this.mailer.send({
      kind: 'invite',
      to: body.email,
      userId: null,
      // The template names the role in the reader's language itself, so it gets the raw role.
      content: renderEmail('invite', ctx.locale, {
        inviterName: inviter.name,
        orgName: account.name,
        role: body.role,
        link: `${this.env.APP_ORIGIN}/invite/${token}`,
      }),
    });
    return { id: created.id, email: body.email, role: body.role, expiresAt: created.expiresAt.toISOString() };
  }

  /** Withdraws a pending invite of the caller's account; its link stops working. */
  async revoke(ctx: RequestContext, id: string): Promise<void> {
    const deleted = await this.db
      .delete(invite)
      .where(byOrg(invite, ctx, eq(invite.id, id), isNull(invite.acceptedAt)))
      .returning({ id: invite.id });
    if (deleted.length === 0) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'This invitation does not exist.');
  }

  /**
   * What `/invite/:token` shows before anything is created. The token is the credential, so the invite is looked up
   * by it and not by an account. A missing, accepted or expired invite is `INVALID_TOKEN`, with one message for all three.
   */
  async preview(token: string): Promise<InvitePreviewResponse> {
    const [row] = await this.db
      .select({
        orgName: org.name,
        email: invite.email,
        role: invite.role,
        existingUser: sql<boolean>`exists (select 1 from ${appUser} where lower(${appUser.email}) = lower(${invite.email}))`,
      })
      .from(invite)
      .innerJoin(org, eq(org.id, invite.orgId))
      .where(and(eq(invite.tokenHash, sha256Hex(token)), isOpen));
    if (!row) throw invalidToken();
    return { orgName: row.orgName, email: row.email, role: row.role as InviteRole, existingUser: row.existingUser };
  }

  /**
   * Joins the account the invite names and opens a session. The invite is locked first, so two accepts of one link
   * take turns and the second finds it used. Then:
   * - an address that has a user needs that user's password (a wrong one counts toward the lockout, like a failed
   *   login), and the user must have no other account (P4-D1); a user already in the invite's own account just uses
   *   the invite up and signs in, with their role unchanged;
   * - a new address needs a name and a password that is not common, and the link verifies it (P4-D8).
   * A wrong password is returned from the transaction rather than thrown, so that counting it commits.
   * `ALREADY_MEMBER` is never answered here: it belongs to the authenticated `POST /org/invites` alone.
   */
  async accept(body: AcceptInviteRequest): Promise<{ me: MeResponse } & SessionTokens> {
    let outcome: AcceptOutcome;
    try {
      outcome = await this.db.transaction((tx) => this.acceptInTransaction(tx, body));
    } catch (error) {
      // A sign-up or another invite created this address between our check and our insert: they have an account now.
      if (isDuplicateEmail(error)) throw alreadyInAccount();
      throw error;
    }
    if (outcome.kind === 'wrong_password') {
      await this.sessions.recordFailure(outcome.userId);
      throw invalidCredentials();
    }
    if (outcome.kind === 'locked') throw invalidCredentials();
    return outcome;
  }

  private async acceptInTransaction(tx: Tx, body: AcceptInviteRequest): Promise<AcceptOutcome> {
    const [pending] = await tx
      .select({
        id: invite.id,
        orgId: invite.orgId,
        email: invite.email,
        role: invite.role,
        invitedBy: invite.invitedBy,
        open: sql<boolean>`${isOpen}`,
      })
      .from(invite)
      .where(eq(invite.tokenHash, sha256Hex(body.token)))
      .for('update');
    if (!pending || !pending.open) throw invalidToken();

    // The user row is locked too: one person accepting two invites at once must end in one account.
    const [existing] = await tx
      .select({
        id: appUser.id,
        passwordHash: appUser.passwordHash,
        locked: sql<boolean>`coalesce(${appUser.lockedUntil} > now(), false)`,
      })
      .from(appUser)
      .where(byEmail(pending.email))
      .for('update');

    let userId: string;
    let alreadyJoined = false;
    if (existing) {
      const matches = await verifyPassword(existing.passwordHash, body.password);
      if (existing.locked) return { kind: 'locked' };
      if (!matches) return { kind: 'wrong_password', userId: existing.id };
      const [account] = await tx.select({ orgId: membership.orgId }).from(membership).where(eq(membership.userId, existing.id)).limit(1);
      // Another account: P4-D1 refuses. This account: nothing to join, so the invite is used up and the role stays as it is.
      if (account && account.orgId !== pending.orgId) throw alreadyInAccount();
      alreadyJoined = account !== undefined;
      // The link reached this inbox, so it verifies the address, as it does for a new person (P4-D8).
      await tx
        .update(appUser)
        .set({ failedLogins: 0, lockedUntil: null, emailVerifiedAt: sql`coalesce(${appUser.emailVerifiedAt}, now())` })
        .where(
          and(
            eq(appUser.id, existing.id),
            sql`(${appUser.failedLogins} <> 0 or ${appUser.lockedUntil} is not null or ${appUser.emailVerifiedAt} is null)`,
          ),
        );
      userId = existing.id;
    } else {
      if (body.name === undefined) throw new AppError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'Your name is needed to create your account.');
      if (isCommonPassword(body.password)) throw commonPasswordError();
      userId = uuidv7();
      await tx.insert(appUser).values({
        id: userId,
        email: pending.email,
        passwordHash: await hashPassword(body.password),
        name: body.name,
        locale: body.locale ?? (await this.inviterLocale(tx, pending.invitedBy)),
        emailVerifiedAt: sql`now()`,
      });
    }

    if (!alreadyJoined) {
      // Accepting counts members only (P5-D3): the open invites, this one included, are not seats yet.
      await this.lockSeats(tx, pending.orgId);
      const [{ members }] = await tx.select({ members: count() }).from(membership).where(byOrg(membership, { orgId: pending.orgId }));
      await this.entitlements.assertCount(pending.orgId, 'members', members, tx);
      await tx.insert(membership).values({ orgId: pending.orgId, userId, role: pending.role });
    }
    await tx.update(invite).set({ acceptedAt: sql`now()` }).where(eq(invite.id, pending.id));
    const tokens = await this.sessions.startSession(tx, userId, pending.orgId);
    return { kind: 'ok', me: await loadMe(tx, userId, { orgId: pending.orgId }), ...tokens };
  }

  /** Makes inviting and accepting into one account take turns while they count its seats, so the last seat goes to one of them. */
  private async lockSeats(tx: Tx, orgId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`members:${orgId}`}, 0))`);
  }

  /** A new person reads the app in the inviter's language unless they pick one; `en` if the inviter has gone. */
  private async inviterLocale(tx: Tx, invitedBy: string | null): Promise<Locale> {
    if (invitedBy === null) return 'en';
    const [inviter] = await tx.select({ locale: appUser.locale }).from(appUser).where(eq(appUser.id, invitedBy));
    return (inviter?.locale as Locale | undefined) ?? 'en';
  }
}
