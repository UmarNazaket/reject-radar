import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from './errors';
import { FixedWindowLimiter, RateLimit, RateLimitGuard, RateLimitRule } from './rate-limit';

describe('FixedWindowLimiter', () => {
  it('allows the limit, refuses the next hit and reopens when the window ends', () => {
    const limiter = new FixedWindowLimiter();
    expect(limiter.hit('k', 2, 1000, 0)).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(limiter.hit('k', 2, 1000, 0).allowed).toBe(true);
    expect(limiter.hit('k', 2, 1000, 0)).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(limiter.hit('k', 2, 1000, 999).allowed).toBe(false);
    expect(limiter.hit('k', 2, 1000, 1000).allowed).toBe(true);
  });

  it('rounds the wait up to whole seconds', () => {
    const limiter = new FixedWindowLimiter();
    limiter.hit('k', 1, 10_000, 0);
    expect(limiter.hit('k', 1, 10_000, 2500).retryAfterSec).toBe(8);
  });

  it('keeps keys independent', () => {
    const limiter = new FixedWindowLimiter();
    limiter.hit('a', 1, 1000, 0);
    expect(limiter.hit('a', 1, 1000, 0).allowed).toBe(false);
    expect(limiter.hit('b', 1, 1000, 0).allowed).toBe(true);
  });

  it('forgets every window on reset', () => {
    const limiter = new FixedWindowLimiter();
    limiter.hit('a', 1, 1000, 0);
    limiter.reset();
    expect(limiter.hit('a', 1, 1000, 0).allowed).toBe(true);
  });

  it('drops expired entries so memory stays bounded', () => {
    const limiter = new FixedWindowLimiter();
    for (let i = 0; i < 100; i++) limiter.hit(`k${i}`, 1, 1000, 0);
    expect(limiter.size).toBe(100);
    limiter.hit('later', 1, 1000, 10 * 60_000);
    expect(limiter.size).toBe(1);
  });

  it('refuses a new key once the map is at its ceiling, but still counts the keys it holds', () => {
    const limiter = new FixedWindowLimiter(3);
    for (const key of ['a', 'b', 'c']) expect(limiter.hit(key, 5, 1000, 0).allowed).toBe(true);
    const refused = limiter.hit('d', 5, 1000, 0);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(limiter.size).toBe(3);
    expect(limiter.hit('a', 5, 1000, 0).allowed).toBe(true);
  });

  it('makes room again once the swept windows have passed', () => {
    const limiter = new FixedWindowLimiter(3);
    for (const key of ['a', 'b', 'c']) limiter.hit(key, 5, 1000, 0);
    expect(limiter.hit('d', 5, 1000, 10 * 60_000).allowed).toBe(true);
    expect(limiter.size).toBe(1);
  });
});

describe('RateLimitGuard', () => {
  const login: RateLimitRule = { name: 'login', limit: 2, windowMs: 60_000, key: 'ip+email' };

  interface Route {
    handler: () => void;
    class: new () => unknown;
  }

  interface FakeRequest {
    ip?: string;
    body?: unknown;
    context?: { userId: string };
  }

  function route(...rules: RateLimitRule[]): Route {
    class Controller {
      @RateLimit(...rules)
      handle(): void {
        // decorated only for its metadata
      }
    }
    return { handler: Controller.prototype.handle, class: Controller };
  }

  function contextFor(target: Route, req: FakeRequest) {
    const res = { setHeader: jest.fn() };
    const context = {
      getHandler: () => target.handler,
      getClass: () => target.class,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    return { context, res };
  }

  function setup() {
    const limiter = new FixedWindowLimiter();
    return { limiter, guard: new RateLimitGuard(new Reflector(), limiter) };
  }

  function refusal(run: () => unknown): AppError {
    try {
      run();
    } catch (error) {
      return error as AppError;
    }
    throw new Error('expected a 429');
  }

  it('lets a route without rules through', () => {
    const { guard } = setup();
    expect(guard.canActivate(contextFor(route(), { ip: '1.1.1.1' }).context)).toBe(true);
  });

  it('answers 429 RATE_LIMITED with Retry-After once the limit is spent', () => {
    const { guard } = setup();
    const target = route(login);
    const req = { ip: '1.1.1.1', body: { email: 'a@example.com' } };
    expect(guard.canActivate(contextFor(target, req).context)).toBe(true);
    expect(guard.canActivate(contextFor(target, req).context)).toBe(true);
    const { context, res } = contextFor(target, req);
    const error = refusal(() => guard.canActivate(context));
    expect(error).toBeInstanceOf(AppError);
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.message).toBe('Too many requests. Try again later.');
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^[1-9]\d*$/));
  });

  it('trims and lowercases the email so spelling variants share one counter', () => {
    const { guard } = setup();
    const target = route(login);
    guard.canActivate(contextFor(target, { ip: '1.1.1.1', body: { email: 'Ayesha@Example.com' } }).context);
    guard.canActivate(contextFor(target, { ip: '1.1.1.1', body: { email: '  ayesha@example.com ' } }).context);
    expect(() => guard.canActivate(contextFor(target, { ip: '1.1.1.1', body: { email: ' AYESHA@example.COM' } }).context)).toThrow(AppError);
    // another email from the same IP, and the same email from another IP, are separate counters
    expect(guard.canActivate(contextFor(target, { ip: '1.1.1.1', body: { email: 'other@example.com' } }).context)).toBe(true);
    expect(guard.canActivate(contextFor(target, { ip: '2.2.2.2', body: { email: 'ayesha@example.com' } }).context)).toBe(true);
  });

  it('keys ip+email on the IP alone when the body has no email', () => {
    const { guard } = setup();
    const target = route(login);
    guard.canActivate(contextFor(target, { ip: '1.1.1.1', body: {} }).context);
    guard.canActivate(contextFor(target, { ip: '1.1.1.1' }).context);
    expect(() => guard.canActivate(contextFor(target, { ip: '1.1.1.1', body: { other: 'x' } }).context)).toThrow(AppError);
    expect(guard.canActivate(contextFor(target, { ip: '2.2.2.2', body: {} }).context)).toBe(true);
  });

  it('puts a non-string or over-long email into one shared invalid bucket per rule', () => {
    const { guard, limiter } = setup();
    const hit = jest.spyOn(limiter, 'hit');
    const byEmail = route({ name: 'forgot-email', limit: 2, windowMs: 60_000, key: 'email' });
    const long = `${'a'.repeat(288)}@example.com`; // 300 characters
    expect(long).toHaveLength(300);
    guard.canActivate(contextFor(byEmail, { ip: '1.1.1.1', body: { email: long } }).context);
    expect(hit).toHaveBeenLastCalledWith('forgot-email|(invalid)', 2, 60_000);
    // a different junk value from another IP spends from the same bucket
    guard.canActivate(contextFor(byEmail, { ip: '2.2.2.2', body: { email: 42 } }).context);
    expect(hit).toHaveBeenLastCalledWith('forgot-email|(invalid)', 2, 60_000);
    expect(() => guard.canActivate(contextFor(byEmail, { ip: '3.3.3.3', body: { email: `b${long}` } }).context)).toThrow(AppError);
    expect(limiter.size).toBe(1);
    // ip+email keeps the IP and replaces only the email
    guard.canActivate(contextFor(route(login), { ip: '1.1.1.1', body: { email: long } }).context);
    expect(hit).toHaveBeenLastCalledWith('login|1.1.1.1|(invalid)', 2, 60_000);
    // 254 characters is still a real key
    const longest = `${'a'.repeat(242)}@example.com`;
    guard.canActivate(contextFor(byEmail, { ip: '1.1.1.1', body: { email: longest } }).context);
    expect(hit).toHaveBeenLastCalledWith(`forgot-email|${longest}`, 2, 60_000);
  });

  it('counts every rule on a route and refuses with the largest Retry-After', () => {
    const { guard, limiter } = setup();
    const hit = jest.spyOn(limiter, 'hit');
    const short: RateLimitRule = { name: 'short', limit: 1, windowMs: 10_000, key: 'ip' };
    const long: RateLimitRule = { name: 'long', limit: 1, windowMs: 3_600_000, key: 'email' };
    const target = route(short, long);
    const req = { ip: '1.1.1.1', body: { email: 'a@example.com' } };
    guard.canActivate(contextFor(target, req).context);
    hit.mockClear();
    const { context, res } = contextFor(target, req);
    expect(() => guard.canActivate(context)).toThrow(AppError);
    expect(hit).toHaveBeenCalledTimes(2); // the second rule is hit even though the first already refused
    const [, seconds] = res.setHeader.mock.calls[0];
    expect(Number(seconds)).toBeGreaterThan(10);
  });

  it('keeps the limits of different rules independent even for the same key', () => {
    const { guard } = setup();
    const a = route({ name: 'a', limit: 1, windowMs: 60_000, key: 'ip' });
    const b = route({ name: 'b', limit: 1, windowMs: 60_000, key: 'ip' });
    guard.canActivate(contextFor(a, { ip: '1.1.1.1' }).context);
    expect(() => guard.canActivate(contextFor(a, { ip: '1.1.1.1' }).context)).toThrow(AppError);
    expect(guard.canActivate(contextFor(b, { ip: '1.1.1.1' }).context)).toBe(true);
  });

  it('keys a user rule on the signed-in user, and on the IP when there is no request context', () => {
    const { guard } = setup();
    const target = route({ name: 'invites', limit: 1, windowMs: 60_000, key: 'user' });
    guard.canActivate(contextFor(target, { ip: '1.1.1.1', context: { userId: 'u1' } }).context);
    // the same user from another IP is still the same counter
    expect(() => guard.canActivate(contextFor(target, { ip: '9.9.9.9', context: { userId: 'u1' } }).context)).toThrow(AppError);
    expect(guard.canActivate(contextFor(target, { ip: '1.1.1.1', context: { userId: 'u2' } }).context)).toBe(true);
    // no context: the IP is the key
    guard.canActivate(contextFor(target, { ip: '3.3.3.3' }).context);
    expect(() => guard.canActivate(contextFor(target, { ip: '3.3.3.3' }).context)).toThrow(AppError);
    expect(guard.canActivate(contextFor(target, { ip: '4.4.4.4' }).context)).toBe(true);
  });
});
