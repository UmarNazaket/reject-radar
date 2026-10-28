import { Body, Controller, Delete, HttpCode, HttpStatus, Inject, Param, Post, Res } from '@nestjs/common';
import {
  type AcceptInviteRequest,
  acceptInviteRequest,
  type ApiEnv,
  type CreateInviteRequest,
  createInviteRequest,
  type InvitePreviewResponse,
  type InviteResponse,
  type MeResponse,
  type TokenRequest,
  tokenRequest,
} from '@rejectradar/contracts';
import type { Response } from 'express';
import type { RequestContext } from '../auth/context';
import { setSessionCookies } from '../auth/cookies';
import { CurrentContext, Public, RequireVerifiedEmail, Roles } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit';
import { ZodValidationPipe } from '../common/zod-pipe';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { API_ENV } from '../config/env';
import { InvitesService } from './invites.service';

const HOUR_MS = 3_600_000;

@Controller()
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Post('org/invites')
  @Roles('owner', 'admin')
  @RequireVerifiedEmail()
  @RateLimit({ name: 'invite', limit: 20, windowMs: HOUR_MS, key: 'user' })
  create(
    @CurrentContext() ctx: RequestContext,
    @Body(new ZodValidationPipe(createInviteRequest)) body: CreateInviteRequest,
  ): Promise<InviteResponse> {
    return this.invites.create(ctx, body);
  }

  @Delete('org/invites/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('owner', 'admin')
  async revoke(@CurrentContext() ctx: RequestContext, @Param('id', new UuidParamPipe()) id: string): Promise<void> {
    await this.invites.revoke(ctx, id);
  }

  /** The token travels in the body, never in a URL the API logs (P4-D6). */
  @Public()
  @Post('invites/preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body(new ZodValidationPipe(tokenRequest)) body: TokenRequest): Promise<InvitePreviewResponse> {
    return this.invites.preview(body.token);
  }

  @Public()
  @Post('invites/accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @Body(new ZodValidationPipe(acceptInviteRequest)) body: AcceptInviteRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const { me, access, refresh } = await this.invites.accept(body);
    setSessionCookies(res, this.env, access, refresh);
    return me;
  }
}
