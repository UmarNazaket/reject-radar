import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_PREFIX } from '@rejectradar/contracts';
import { apiKey, type Database, org } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../../common/errors';
import { sha256Hex } from '../../common/tokens';
import { DB } from '../../database/database.module';
import { EntitlementsService } from '../../entitlements/entitlements.service';
import type { ApiKeyRequest } from '../context';
import { API_KEY_AUTH } from '../decorators';

/** `last_used_at` is written at most this often per key, so calls do not write on every request. */
const LAST_USED_INTERVAL_MS = 3_600_000;

/**
 * Signs in the caller of an `@ApiKeyAuth()` route from `Authorization: Bearer rr_live_…`. The key must be live, its
 * account active and on a plan with the API; a downgrade stops the key without deleting it. Other routes pass through.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.reflector.getAllAndOverride<boolean | undefined>(API_KEY_AUTH, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<ApiKeyRequest>();

    const key = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (key === undefined || !key.startsWith(API_KEY_PREFIX)) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'API_KEY_MISSING', 'Send your API key as "Authorization: Bearer rr_live_…".');
    }
    const [row] = await this.db
      .select({ id: apiKey.id, orgId: apiKey.orgId, lastUsedAt: apiKey.lastUsedAt, revokedAt: apiKey.revokedAt, deactivatedAt: org.deactivatedAt })
      .from(apiKey)
      .innerJoin(org, eq(org.id, apiKey.orgId))
      .where(eq(apiKey.keyHash, sha256Hex(key)))
      .limit(1);
    if (!row || row.revokedAt !== null) throw new AppError(HttpStatus.UNAUTHORIZED, 'API_KEY_INVALID', 'This API key is not valid or has been revoked.');
    if (row.deactivatedAt !== null) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated. Contact support.');
    }
    await this.entitlements.assertFeature(row.orgId, 'api');

    if (row.lastUsedAt === null || Date.now() - row.lastUsedAt.getTime() >= LAST_USED_INTERVAL_MS) {
      await this.db.update(apiKey).set({ lastUsedAt: sql`now()` }).where(eq(apiKey.id, row.id));
    }
    req.apiKey = { keyId: row.id, orgId: row.orgId };
    return true;
  }
}
