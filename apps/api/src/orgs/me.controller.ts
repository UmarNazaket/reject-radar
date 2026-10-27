import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { type MeResponse, type PatchMeRequest, patchMeRequest } from '@rejectradar/contracts';
import { appUser, type Database } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { CurrentContext } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-pipe';
import { DB } from '../database/database.module';
import { loadMe } from './me.queries';

@Controller('me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  get(@CurrentContext() ctx: RequestContext): Promise<MeResponse> {
    return loadMe(this.db, ctx.userId, ctx);
  }

  /** Changes the caller's own name and language. `app_user` has no `org_id`: a user only ever edits themselves. */
  @Patch()
  async patch(
    @CurrentContext() ctx: RequestContext,
    @Body(new ZodValidationPipe(patchMeRequest)) body: PatchMeRequest,
  ): Promise<MeResponse> {
    await this.db.update(appUser).set({ name: body.name, locale: body.locale }).where(eq(appUser.id, ctx.userId));
    return loadMe(this.db, ctx.userId, ctx);
  }
}
