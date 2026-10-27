import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../common/errors';
import type { ContextRequest } from '../context';
import { IS_PUBLIC, REQUIRE_VERIFIED_EMAIL } from '../decorators';

@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;
    if (!this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_VERIFIED_EMAIL, targets)) return true;
    if (context.switchToHttp().getRequest<ContextRequest>().context?.emailVerified) return true;
    throw new AppError(HttpStatus.FORBIDDEN, 'EMAIL_NOT_VERIFIED', 'Verify your email address to continue.');
  }
}
