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

  it('evicts the oldest counter instead of refusing when the map is at its ceiling', () => {
    const limiter = new FixedWindowLimiter(3);
    for (const key of ['a', 'b', 'c']) expect(limiter.hit(key, 1, 60_000, 0).allowed).toBe(true);
    expect(limiter.hit('d', 1, 60_000, 0)).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(limiter.size).toBe(3);
    // 'a' was the oldest and is gone, so it starts fresh (and in turn evicts 'b')
    expect(limiter.hit('a', 1, 60_000, 0).allowed).toBe(true);
    // 'c' and 'd' were never evicted, so their counters are still spent
    expect(limiter.hit('c', 1, 60_000, 0).allowed).toBe(false);
    expect(limiter.hit('d', 1, 60_000, 0).allowed).toBe(false);
    expect(limiter.size).toBe(3);
  });

  it('counts a key whose window restarted as the newest, so it is not evicted next', () => {
    const limiter = new FixedWindowLimiter(3);
    limiter.hit('a', 1, 1000, 0); // expires at 1000
    limiter.hit('b', 1, 5000, 0);
    limiter.hit('c', 1, 5000, 0);
    // 'a' restarts at 1500 (the sweep is not due yet), so it moves behind 'b' and 'c'
    expect(limiter.hit('a', 1, 5000, 1500).allowed).toBe(true);
    // a new key at the ceiling evicts 'b', not 'a'
    expect(limiter.hit('d', 1, 5000, 1500).allowed).toBe(true);
    expect(limiter.hit('a', 1, 5000, 1500).allowed).toBe(false);
    expect(limiter.hit('c', 1, 5000, 1500).allowed).toBe(false);
    expect(limiter.hit('b', 1, 5000, 1500).allowed).toBe(true); // evicted, so fresh
  });

  it('makes room again once the swept windows have passed', () => {
    const limiter = new FixedWindowLimiter(3);
    for (const key of ['a', 'b', 'c']) limiter.hit(key, 5, 1000, 0);
    expect(limiter.hit('d', 5, 1000, 10 * 60_000).allowed).toBe(true);
    expect(limiter.size).toBe(1);
  });

  describe('hitAll', () => {
    const HOUR = 3_600_000;

    it('writes nothing when one hit is refused: no entry for the other rules, no counts', () => {
      const limiter = new FixedWindowLimiter();
      limiter.hit('a', 1, HOUR, 0);
      expect(limiter.size).toBe(1);
      const result = limiter.hitAll(
        [
          { key: 'a', limit: 1, windowMs: HOUR },
          { key: 'b', limit: 5, windowMs: HOUR },
        ],
        0,
      );
      expect(result.allowed).toBe(false);
      expect(limiter.size).toBe(1);
      // b was never written, so it still has its full allowance
      for (let i = 0; i < 5; i++) expect(limiter.hit('b', 5, HOUR, 0).allowed).toBe(true);
      expect(limiter.hit('b', 5, HOUR, 0).allowed).toBe(false);
    });

    it('does not increment any counter of a refused request', () => {
      const limiter = new FixedWindowLimiter();
      limiter.hit('a', 1, HOUR, 0);
      limiter.hit('b', 3, HOUR, 0); // b has used 1 of 3
      for (let i = 0; i < 10; i++) {
        expect(limiter.hitAll([{ key: 'a', limit: 1, windowMs: HOUR }, { key: 'b', limit: 3, windowMs: HOUR }], 0).allowed).toBe(false);
      }
      // b still has 2 left: refusals did not spend them
      expect(limiter.hit('b', 3, HOUR, 0).allowed).toBe(true);
      expect(limiter.hit('b', 3, HOUR, 0).allowed).toBe(true);
      expect(limiter.hit('b', 3, HOUR, 0).allowed).toBe(false);
    });

    it('counts every hit of an allowed request', () => {
      const limiter = new FixedWindowLimiter();
      const hits = [{ key: 'a', limit: 2, windowMs: HOUR }, { key: 'b', limit: 2, windowMs: HOUR }];
      expect(limiter.hitAll(hits, 0)).toEqual({ allowed: true, retryAfterSec: 0 });
      expect(limiter.hitAll(hits, 0).allowed).toBe(true);
      expect(limiter.hitAll(hits, 0).allowed).toBe(false);
      expect(limiter.size).toBe(2);
    });

    it('answers Retry-After with the time left on the refusing window', () => {
      const limiter = new FixedWindowLimiter();
      limiter.hit('a', 1, HOUR, 0);
      expect(limiter.hit('a', 1, HOUR, 10 * 60_000)).toEqual({ allowed: false, retryAfterSec: 3000 });
    });

    it('answers the largest Retry-After when two rules refuse', () => {
      const limiter = new FixedWindowLimiter();
      limiter.hit('short', 1, 60_000, 0);
      limiter.hit('long', 1, HOUR, 0);
      const result = limiter.hitAll([{ key: 'short', limit: 1, windowMs: 60_000 }, { key: 'long', limit: 1, windowMs: HOUR }], 30_000);
      expect(result).toEqual({ allowed: false, retryAfterSec: 3570 });
    });

    it('treats an expired window as absent', () => {
      const limiter = new FixedWindowLimiter();
      limiter.hit('a', 1, 1000, 0);
      expect(limiter.hitAll([{ key: 'a', limit: 1, windowMs: 1000 }], 1000).allowed).toBe(true);
    });

    it('survives a flood of distinct emails from one IP after the IP limit is spent', () => {
      const limiter = new FixedWindowLimiter(50);
      const forgot = (ip: string, email: string) =>
        limiter.hitAll(
          [
            { key: `forgot-email|${email}`, limit: 5, windowMs: HOUR },
            { key: `forgot-ip|${ip}`, limit: 20, windowMs: HOUR },
          ],
          0,
        );
      for (let i = 0; i < 20; i++) expect(forgot('1.1.1.1', `spent${i}@example.com`).allowed).toBe(true);
      for (let i = 0; i < 1000; i++) expect(forgot('1.1.1.1', `flood${i}@example.com`).allowed).toBe(false);
      expect(limiter.size).toBeLessThanOrEqual(50);
      expect(forgot('2.2.2.2', 'someone@example.com')).toEqual({ allowed: true, retryAfterSec: 0 });
    });
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
    const hitAll = jest.spyOn(limiter, 'hitAll');
    const byEmail = route({ name: 'forgot-email', limit: 2, windowMs: 60_000, key: 'email' });
    const long = `${'a'.repeat(288)}@example.com`; // 300 characters
    expect(long).toHaveLength(300);
    guard.canActivate(contextFor(byEmail, { ip: '1.1.1.1', body: { email: long } }).context);
    expect(hitAll).toHaveBeenLastCalledWith([{ key: 'forgot-email|(invalid)', limit: 2, windowMs: 60_000 }]);
    // a different junk value from another IP spends from the same bucket
    guard.canActivate(contextFor(byEmail, { ip: '2.2.2.2', body: { email: 42 } }).context);
    expect(hitAll).toHaveBeenLastCalledWith([{ key: 'forgot-email|(invalid)', limit: 2, windowMs: 60_000 }]);
    expect(() => guard.canActivate(contextFor(byEmail, { ip: '3.3.3.3', body: { email: `b${long}` } }).context)).toThrow(AppError);
    expect(limiter.size).toBe(1);
    // ip+email keeps the IP and replaces only the email
    guard.canActivate(contextFor(route(login), { ip: '1.1.1.1', body: { email: long } }).context);
    expect(hitAll).toHaveBeenLastCalledWith([{ key: 'login|1.1.1.1|(invalid)', limit: 2, windowMs: 60_000 }]);
    // 254 characters is still a real key
    const longest = `${'a'.repeat(242)}@example.com`;
    guard.canActivate(contextFor(byEmail, { ip: '1.1.1.1', body: { email: longest } }).context);
    expect(hitAll).toHaveBeenLastCalledWith([{ key: `forgot-email|${longest}`, limit: 2, windowMs: 60_000 }]);
  });

  it('checks every rule in one call, writes nothing when one refuses, and answers the largest Retry-After', () => {
    const { guard, limiter } = setup();
    const hitAll = jest.spyOn(limiter, 'hitAll');
    const short: RateLimitRule = { name: 'short', limit: 1, windowMs: 10_000, key: 'ip' };
    const long: RateLimitRule = { name: 'long', limit: 1, windowMs: 3_600_000, key: 'email' };
    const target = route(short, long);
    const req = { ip: '1.1.1.1', body: { email: 'a@example.com' } };
    guard.canActivate(contextFor(target, req).context);
    hitAll.mockClear();
    const { context, res } = contextFor(target, req);
    expect(() => guard.canActivate(context)).toThrow(AppError);
    expect(hitAll).toHaveBeenCalledTimes(1);
    expect(hitAll.mock.calls[0][0]).toHaveLength(2);
    const [, seconds] = res.setHeader.mock.calls[0];
    expect(Number(seconds)).toBeGreaterThan(10);
    // a refused request wrote no entry for a fresh address
    const size = limiter.size;
    expect(() => guard.canActivate(contextFor(target, { ip: '1.1.1.1', body: { email: 'fresh@example.com' } }).context)).toThrow(AppError);
    expect(limiter.size).toBe(size);
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
