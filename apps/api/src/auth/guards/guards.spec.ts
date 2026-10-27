import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../common/errors';
import type { RequestContext } from '../context';
import { RequireVerifiedEmail, Roles, SkipCsrf } from '../decorators';
import { CsrfGuard } from './csrf.guard';
import { RolesGuard } from './roles.guard';
import { VerifiedEmailGuard } from './verified-email.guard';

const baseContext: RequestContext = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'member',
  locale: 'en',
  emailVerified: true,
  isPlatformAdmin: false,
  familyId: 'family-1',
};

interface FakeRequest {
  method: string;
  headers: Record<string, string>;
  context?: RequestContext;
}

class Handlers {
  @SkipCsrf()
  skipped(): void {
    /* marker handler: only its metadata matters */
  }
  plain(): void {
    /* marker handler: only its metadata matters */
  }
  @Roles('owner', 'admin')
  managers(): void {
    /* marker handler: only its metadata matters */
  }
  @RequireVerifiedEmail()
  verified(): void {
    /* marker handler: only its metadata matters */
  }
}

function executionContext(req: FakeRequest, handler: () => void): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function refusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the guard to refuse');
}

describe('CsrfGuard', () => {
  const guard = new CsrfGuard(new Reflector());
  const handlers = new Handlers();

  it('refuses a POST without the header with 403 CSRF_MISSING', () => {
    const error = refusal(() => guard.canActivate(executionContext({ method: 'POST', headers: {} }, handlers.plain)));
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('CSRF_MISSING');
    expect(error.message).toBe('Missing X-RejectRadar-CSRF header.');
  });

  it('refuses a header that is not exactly 1', () => {
    for (const value of ['0', '', 'true', '11']) {
      const req = { method: 'POST', headers: { 'x-rejectradar-csrf': value } };
      expect(refusal(() => guard.canActivate(executionContext(req, handlers.plain))).code).toBe('CSRF_MISSING');
    }
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('refuses a %s without the header', (method) => {
    expect(refusal(() => guard.canActivate(executionContext({ method, headers: {} }, handlers.plain))).code).toBe('CSRF_MISSING');
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('allows %s without the header', (method) => {
    expect(guard.canActivate(executionContext({ method, headers: {} }, handlers.plain))).toBe(true);
  });

  it('allows a POST with the header set to 1', () => {
    const req = { method: 'POST', headers: { 'x-rejectradar-csrf': '1' } };
    expect(guard.canActivate(executionContext(req, handlers.plain))).toBe(true);
  });

  it('allows a POST on a @SkipCsrf() handler without the header', () => {
    expect(guard.canActivate(executionContext({ method: 'POST', headers: {} }, handlers.skipped))).toBe(true);
  });
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const handlers = new Handlers();

  it('refuses a member on @Roles(owner, admin) with 403 FORBIDDEN', () => {
    const req = { method: 'GET', headers: {}, context: { ...baseContext, role: 'member' as const } };
    const error = refusal(() => guard.canActivate(executionContext(req, handlers.managers)));
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('allows the listed roles', () => {
    for (const role of ['owner', 'admin'] as const) {
      const req = { method: 'GET', headers: {}, context: { ...baseContext, role } };
      expect(guard.canActivate(executionContext(req, handlers.managers))).toBe(true);
    }
  });

  it('allows any role on a handler without @Roles', () => {
    const req = { method: 'GET', headers: {}, context: baseContext };
    expect(guard.canActivate(executionContext(req, handlers.plain))).toBe(true);
  });
});

describe('VerifiedEmailGuard', () => {
  const guard = new VerifiedEmailGuard(new Reflector());
  const handlers = new Handlers();

  it('refuses an unverified email with 403 EMAIL_NOT_VERIFIED', () => {
    const req = { method: 'POST', headers: {}, context: { ...baseContext, emailVerified: false } };
    const error = refusal(() => guard.canActivate(executionContext(req, handlers.verified)));
    expect(error.getStatus()).toBe(403);
    expect(error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('allows a verified email, and an unverified one on a handler that does not require it', () => {
    const verified = { method: 'POST', headers: {}, context: baseContext };
    expect(guard.canActivate(executionContext(verified, handlers.verified))).toBe(true);
    const unverified = { method: 'GET', headers: {}, context: { ...baseContext, emailVerified: false } };
    expect(guard.canActivate(executionContext(unverified, handlers.plain))).toBe(true);
  });
});
