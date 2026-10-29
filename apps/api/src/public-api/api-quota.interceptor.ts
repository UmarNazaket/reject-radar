import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import type { ApiKeyRequest } from '../auth/context';
import { EntitlementsService } from '../entitlements/entitlements.service';

/**
 * Charges one `api_calls` unit for a public API call, or refuses it with `403 PLAN_LIMIT_REACHED` at the monthly quota.
 * Interceptors run after every guard, so a call the key guard or the rate limiter refuses is never charged.
 */
@Injectable()
export class ApiQuotaInterceptor implements NestInterceptor {
  constructor(private readonly entitlements: EntitlementsService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const { apiKey } = http.getRequest<ApiKeyRequest>();
    // ApiKeyGuard has set `apiKey` on every route this interceptor is applied to.
    if (apiKey !== undefined) {
      const { used, limit } = await this.entitlements.consume(apiKey.orgId, 'api_calls', 1);
      const res = http.getResponse<Response>();
      res.setHeader('X-Quota-Used', String(used));
      res.setHeader('X-Quota-Limit', String(limit));
    }
    return next.handle();
  }
}
