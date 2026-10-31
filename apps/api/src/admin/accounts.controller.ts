import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type AdminOrgQuery,
  adminOrgQuery,
  type AdminOrgResponse,
  type AdminOrgsResponse,
  type AuditQuery,
  auditQuery,
  type AuditResponse,
  type PlanOverrideRequest,
  planOverrideRequest,
} from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, PlatformAdmin, RequireVerifiedEmail } from '../auth/decorators';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { AccountsService } from './accounts.service';

/** Accounts and the audit log, for RejectRadar staff (P10). */
@Controller('admin')
@PlatformAdmin()
@RequireVerifiedEmail()
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('orgs')
  list(@Query(new ZodValidationPipe(adminOrgQuery)) query: AdminOrgQuery): Promise<AdminOrgsResponse> {
    return this.accounts.list(query);
  }

  @Get('orgs/:id')
  detail(@Param('id', new UuidParamPipe()) id: string): Promise<AdminOrgResponse> {
    return this.accounts.detail(id);
  }

  @Patch('orgs/:id')
  setPlanOverride(
    @CurrentContext() ctx: RequestContext,
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new ZodValidationPipe(planOverrideRequest)) body: PlanOverrideRequest,
  ): Promise<AdminOrgResponse> {
    return this.accounts.setPlanOverride(ctx, id, body);
  }

  @Post('orgs/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(@CurrentContext() ctx: RequestContext, @Param('id', new UuidParamPipe()) id: string): Promise<AdminOrgResponse> {
    return this.accounts.setActive(ctx, id, false);
  }

  @Post('orgs/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(@CurrentContext() ctx: RequestContext, @Param('id', new UuidParamPipe()) id: string): Promise<AdminOrgResponse> {
    return this.accounts.setActive(ctx, id, true);
  }

  @Get('audit')
  audit(@Query(new ZodValidationPipe(auditQuery)) query: AuditQuery): Promise<AuditResponse> {
    return this.accounts.audit(query);
  }
}
