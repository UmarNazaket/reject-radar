import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch } from '@nestjs/common';
import {
  type MembersResponse,
  type OrgResponse,
  type PatchMemberRequest,
  type PatchOrgRequest,
  patchMemberRequest,
  patchOrgRequest,
} from '@rejectradar/contracts';
import { type Database, org } from '@rejectradar/db';
import { eq } from 'drizzle-orm';
import type { RequestContext } from '../auth/context';
import { CurrentContext, Roles } from '../auth/decorators';
import { AppError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-pipe';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { DB } from '../database/database.module';
import { MembersService } from './members.service';

/** The caller's own account: its settings and its members. The account is always the session's, never a path or body value. */
@Controller('org')
export class OrgController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly members: MembersService,
  ) {}

  @Get()
  async get(@CurrentContext() ctx: RequestContext): Promise<OrgResponse> {
    return this.load(ctx);
  }

  @Patch()
  @Roles('owner', 'admin')
  async patch(
    @CurrentContext() ctx: RequestContext,
    @Body(new ZodValidationPipe(patchOrgRequest)) body: PatchOrgRequest,
  ): Promise<OrgResponse> {
    await this.db.update(org).set({ name: body.name }).where(eq(org.id, ctx.orgId));
    return this.load(ctx);
  }

  @Get('members')
  listMembers(@CurrentContext() ctx: RequestContext): Promise<MembersResponse> {
    return this.members.list(ctx);
  }

  @Patch('members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('owner', 'admin')
  async changeRole(
    @CurrentContext() ctx: RequestContext,
    @Param('userId', new UuidParamPipe()) userId: string,
    @Body(new ZodValidationPipe(patchMemberRequest)) body: PatchMemberRequest,
  ): Promise<void> {
    await this.members.changeRole(ctx, userId, body.role);
  }

  /** Owners and admins remove members; anyone may remove themselves, which is how a member leaves. */
  @Delete('members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentContext() ctx: RequestContext, @Param('userId', new UuidParamPipe()) userId: string): Promise<void> {
    await this.members.remove(ctx, userId);
  }

  private async load(ctx: RequestContext): Promise<OrgResponse> {
    const [row] = await this.db.select({ id: org.id, name: org.name, createdAt: org.createdAt }).from(org).where(eq(org.id, ctx.orgId));
    if (!row) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'This account does not exist.');
    return { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
  }
}
