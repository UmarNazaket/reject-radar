import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { type ApiKeysResponse, type CreateApiKeyRequest, createApiKeyRequest, type CreatedApiKeyResponse } from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, RequireVerifiedEmail, Roles } from '../auth/decorators';
import { RateLimit } from '../common/rate-limit';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { ApiKeysService } from './api-keys.service';

/** The account's public API keys, managed by its owners and admins. */
@Controller('org/api-keys')
@Roles('owner', 'admin')
@RequireVerifiedEmail()
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  list(@CurrentContext() ctx: RequestContext): Promise<ApiKeysResponse> {
    return this.keys.list(ctx);
  }

  @Post()
  @RateLimit({ name: 'api-key-create', limit: 10, windowMs: 3_600_000, key: 'user' })
  create(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createApiKeyRequest)) body: CreateApiKeyRequest): Promise<CreatedApiKeyResponse> {
    return this.keys.create(ctx, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(@CurrentContext() ctx: RequestContext, @Param('id', new UuidParamPipe()) id: string): Promise<void> {
    return this.keys.revoke(ctx, id);
  }
}
