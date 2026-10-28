import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CreateDisputeRequest, DisputeResponse, FirmRecordSource } from '@rejectradar/contracts';
import { type Database, dispute, uuidv7 } from '@rejectradar/db';
import { type SQL, sql } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { AppError } from '../common/errors';
import { DB } from '../database/database.module';
import { FirmProfileService } from './firm-profile.service';

/** The row of each source that `sourceKey` names, when it is linked to the firm. */
const RECORD_OF_FIRM: Readonly<Record<FirmRecordSource, (firmId: number, key: string) => SQL>> = {
  fda_refusal: (firmId, key) => sql`select 1 from fda_refusal where firm_id = ${firmId}::bigint and source_key = ${key}`,
  import_alert: (firmId, key) => sql`select 1 from import_alert_listing where firm_id = ${firmId}::bigint and listing_key = ${key}`,
  au_ifis: (firmId, key) => sql`select 1 from au_failing_food where firm_id = ${firmId}::bigint and source_key = ${key}`,
};

/** Disputes (P5-D17): an account says a firm's facts, or a record linked to the firm, are wrong. Staff review them; there is no read here. */
@Injectable()
export class DisputesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly profiles: FirmProfileService,
  ) {}

  /** Files the dispute in the caller's account, against the firm `id` stands for (a merged-away id files against the survivor). */
  async create(ctx: Pick<RequestContext, 'orgId' | 'userId'>, id: number, body: CreateDisputeRequest): Promise<DisputeResponse> {
    const firmId = await this.profiles.resolveId(id);
    if (firmId === null) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found.');

    const { source, sourceKey } = body;
    if (source !== undefined && sourceKey !== undefined) {
      const { rows } = await this.db.execute(sql`select exists (${RECORD_OF_FIRM[source](firmId, sourceKey)}) as found`);
      if ((rows[0] as { found: boolean }).found !== true) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_RECORD', 'That record is not one of this firm\'s.');
      }
    }

    const row = { id: uuidv7(), orgId: ctx.orgId, userId: ctx.userId, firmId, source: source ?? null, sourceKey: sourceKey ?? null, kind: body.kind, message: body.message };
    await this.db.insert(dispute).values(row);
    return { id: row.id };
  }
}
