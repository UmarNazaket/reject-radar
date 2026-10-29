import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_KEY_DISPLAY_LENGTH,
  API_KEY_PREFIX,
  type ApiKeyItem,
  type ApiKeysResponse,
  type CreateApiKeyRequest,
  type CreatedApiKeyResponse,
  MAX_API_KEYS,
} from '@rejectradar/contracts';
import { apiKey, appUser, auditLog, type Database } from '@rejectradar/db';
import { count, desc, eq, isNull, sql } from 'drizzle-orm';
import { byOrg, type RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { uuidv7 } from '../common/ids';
import { randomToken, sha256Hex } from '../common/tokens';
import { DB } from '../database/database.module';
import { EntitlementsService } from '../entitlements/entitlements.service';

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');

/** The account's public API keys. A key is shown once, at creation; only its SHA-256 is stored. */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(ctx: RequestContext): Promise<ApiKeysResponse> {
    const rows = await this.db
      .select({
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        createdByName: appUser.name,
        createdAt: apiKey.createdAt,
        lastUsedAt: apiKey.lastUsedAt,
        revokedAt: apiKey.revokedAt,
      })
      .from(apiKey)
      .leftJoin(appUser, eq(appUser.id, apiKey.createdBy))
      .where(byOrg(apiKey, ctx))
      .orderBy(desc(apiKey.createdAt));
    return {
      keys: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Creates a key on a plan with the API, while the account holds fewer than `MAX_API_KEYS` live keys. */
  async create(ctx: RequestContext, body: CreateApiKeyRequest): Promise<CreatedApiKeyResponse> {
    await this.entitlements.assertFeature(ctx.orgId, 'api');
    const key = `${API_KEY_PREFIX}${randomToken()}`;
    const row = { id: uuidv7(), orgId: ctx.orgId, name: body.name, prefix: key.slice(0, API_KEY_DISPLAY_LENGTH), keyHash: sha256Hex(key), createdBy: ctx.userId };
    const createdAt = await this.db.transaction(async (tx) => {
      // The count and the insert are one step per account, so two creates of the last key cannot both pass.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('api_key:' || ${ctx.orgId}::text, 0))`);
      const [{ live }] = await tx.select({ live: count() }).from(apiKey).where(byOrg(apiKey, ctx, isNull(apiKey.revokedAt)));
      if (live >= MAX_API_KEYS) {
        throw new AppError(HttpStatus.CONFLICT, 'API_KEY_LIMIT', `An account can hold ${MAX_API_KEYS} API keys. Revoke one first.`);
      }
      const [inserted] = await tx.insert(apiKey).values(row).returning({ createdAt: apiKey.createdAt });
      await tx.insert(auditLog).values({ actorUserId: ctx.userId, action: 'api_key.created', targetType: 'api_key', targetId: row.id, details: { orgId: ctx.orgId, prefix: row.prefix } });
      return inserted.createdAt;
    });
    const [creator] = await this.db.select({ name: appUser.name }).from(appUser).where(eq(appUser.id, ctx.userId));
    const item: ApiKeyItem = { id: row.id, name: row.name, prefix: row.prefix, createdByName: creator?.name ?? null, createdAt: createdAt.toISOString(), lastUsedAt: null, revokedAt: null };
    return { ...item, key };
  }

  /** Revokes a key of the account; revoking it again changes nothing. The row stays as a record. */
  async revoke(ctx: RequestContext, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ revokedAt: apiKey.revokedAt }).from(apiKey).where(byOrg(apiKey, ctx, eq(apiKey.id, id))).for('update');
      if (!row) throw notFound();
      if (row.revokedAt !== null) return;
      await tx.update(apiKey).set({ revokedAt: sql`now()` }).where(byOrg(apiKey, ctx, eq(apiKey.id, id)));
      await tx.insert(auditLog).values({ actorUserId: ctx.userId, action: 'api_key.revoked', targetType: 'api_key', targetId: id, details: { orgId: ctx.orgId } });
    });
  }
}
