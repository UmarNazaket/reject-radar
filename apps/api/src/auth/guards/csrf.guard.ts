import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../../common/errors';
import { SKIP_CSRF } from '../decorators';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every unsafe request must send `X-RejectRadar-CSRF: 1`. A cross-site form or `fetch` cannot add a custom header
 * without a CORS preflight, which only `APP_ORIGIN` passes. It also covers `@Public()` routes.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    if (this.reflector.getAllAndOverride<boolean | undefined>(SKIP_CSRF, [context.getHandler(), context.getClass()])) return true;
    if (req.headers['x-rejectradar-csrf'] === '1') return true;
    throw new AppError(HttpStatus.FORBIDDEN, 'CSRF_MISSING', 'Missing X-RejectRadar-CSRF header.');
  }
}
