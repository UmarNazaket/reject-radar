import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@rejectradar/contracts';
import { AppError } from '../../common/errors';
import type { ContextRequest } from '../context';
import { IS_PUBLIC, PLATFORM_ADMIN, ROLES_METADATA } from '../decorators';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;
    const ctx = context.switchToHttp().getRequest<ContextRequest>().context;
    if (this.reflector.getAllAndOverride<boolean | undefined>(PLATFORM_ADMIN, targets) && !ctx?.isPlatformAdmin) {
      throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Your role does not allow this.');
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_METADATA, targets);
    if (!roles?.length) return true;
    if (ctx && roles.includes(ctx.role)) return true;
    throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Your role does not allow this.');
  }
}
