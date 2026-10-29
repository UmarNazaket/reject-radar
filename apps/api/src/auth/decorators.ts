import { applyDecorators, createParamDecorator, type ExecutionContext, HttpStatus, SetMetadata } from '@nestjs/common';
import type { Role } from '@rejectradar/contracts';
import { AppError } from '../common/errors';
import type { ApiKeyContext, ApiKeyRequest, ContextRequest, RequestContext } from './context';

export const IS_PUBLIC = 'auth:public';
export const SKIP_CSRF = 'auth:skipCsrf';
export const ROLES_METADATA = 'auth:roles';
export const REQUIRE_VERIFIED_EMAIL = 'auth:requireVerifiedEmail';
export const API_KEY_AUTH = 'auth:apiKey';
export const PLATFORM_ADMIN = 'auth:platformAdmin';

/** No sign-in needed: the auth, roles and verified-email guards let the route through. CSRF still applies to unsafe methods. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Exempts the route from the `X-RejectRadar-CSRF` check (the Paddle webhook and `/public/*` endpoints). */
export const SkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_CSRF, true);

/** Only these roles may call the route; anyone else gets `403 FORBIDDEN`. */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_METADATA, roles);

/** Only RejectRadar's own staff (`app_user.is_platform_admin`) may call the route; anyone else gets `403 FORBIDDEN`. */
export const PlatformAdmin = (): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_ADMIN, true);

/** The caller's email must be verified; otherwise `403 EMAIL_NOT_VERIFIED`. */
export const RequireVerifiedEmail = (): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_VERIFIED_EMAIL, true);

/** The `RequestContext` of the signed-in caller. Only valid on a route that is not `@Public()`. */
export const CurrentContext = createParamDecorator((_data: unknown, host: ExecutionContext): RequestContext => {
  const context = host.switchToHttp().getRequest<ContextRequest>().context;
  if (context === undefined) throw new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Sign in to continue.');
  return context;
});

/** A public API route: an API key signs the caller in instead of the session cookie, and there is no CSRF check. */
export const ApiKeyAuth = (): MethodDecorator & ClassDecorator => applyDecorators(SetMetadata(API_KEY_AUTH, true), Public(), SkipCsrf());

/** The key and account of the caller of an `@ApiKeyAuth()` route. */
export const CurrentApiKey = createParamDecorator((_data: unknown, host: ExecutionContext): ApiKeyContext => {
  const apiKey = host.switchToHttp().getRequest<ApiKeyRequest>().apiKey;
  if (apiKey === undefined) throw new AppError(HttpStatus.UNAUTHORIZED, 'API_KEY_MISSING', 'Send an API key.');
  return apiKey;
});
