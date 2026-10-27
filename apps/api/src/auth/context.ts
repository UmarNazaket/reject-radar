import type { Locale, Role } from '@rejectradar/contracts';
import { and, eq, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Request } from 'express';

/**
 * Who is calling, loaded from the database by `AuthGuard` on every request (P4-D3). `orgId` always comes from here,
 * never from the request body, query or path.
 */
export interface RequestContext {
  userId: string;
  orgId: string;
  role: Role;
  locale: Locale;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  /** The refresh-token family of the session; logging out revokes it. */
  familyId: string;
}

/** An Express request after `AuthGuard`: `context` is unset on public routes. The one place the request is typed with it. */
export type ContextRequest = Request & { context?: RequestContext };

/**
 * The `where` clause of an account-owned table: the caller's `orgId` plus any further conditions. Services filter
 * these tables through this and nothing else, so a query can never reach another account's rows.
 */
export function byOrg<T extends { orgId: AnyPgColumn }>(table: T, ctx: RequestContext, ...conditions: (SQL | undefined)[]): SQL {
  return and(eq(table.orgId, ctx.orgId), ...conditions) as SQL;
}
