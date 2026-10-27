import { invite, membership } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { byOrg, type RequestContext } from './context';

const ctx: RequestContext = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  locale: 'en',
  emailVerified: true,
  isPlatformAdmin: false,
  familyId: 'family-1',
};
const dialect = new PgDialect();

describe('byOrg', () => {
  it('filters on the caller org id and nothing else when there are no conditions', () => {
    const query = dialect.sqlToQuery(byOrg(membership, ctx));
    expect(query.sql).toBe('"membership"."org_id" = $1');
    expect(query.params).toEqual(['org-1']);
  });

  it('ands further conditions after the org filter and skips undefined ones', () => {
    const query = dialect.sqlToQuery(byOrg(invite, ctx, eq(invite.email, 'a@example.com'), undefined, sql`true`));
    expect(query.sql).toBe('("invite"."org_id" = $1 and "invite"."email" = $2 and true)');
    expect(query.params).toEqual(['org-1', 'a@example.com']);
  });
});
