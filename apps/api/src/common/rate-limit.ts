import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AppError } from './errors';

export interface RateLimitRule {
  /** Unique per limit; it prefixes the counter key, so two routes never share a counter. */
  name: string;
  limit: number;
  windowMs: number;
  key: 'ip' | 'ip+email' | 'email' | 'user';
}

export interface LimitResult {
  allowed: boolean;
  /** Whole seconds until the window ends; 0 when the hit was allowed. */
  retryAfterSec: number;
}

/** Entries whose window has passed are swept at most this often, so a key that is never seen again does not linger. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * In-memory fixed-window counter. The window opens at a key's first hit and its counter is dropped once the window
 * has passed. State is per process: a restart only resets the windows (P4-D5).
 */
@Injectable()
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep: number | undefined;

  hit(key: string, limit: number, windowMs: number, now: number = Date.now()): LimitResult {
    this.sweep(now);
    let entry = this.windows.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, entry);
    }
    if (entry.count >= limit) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    entry.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Forgets every window; tests call it between cases. */
  reset(): void {
    this.windows.clear();
    this.lastSweep = undefined;
  }

  /** Number of live counters (for tests). */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    if (this.lastSweep !== undefined && now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(key);
  }
}

export const RATE_LIMIT_METADATA = 'rateLimit:rules';

/** Applies every rule to the route (or controller); the request is refused if any of them refuses. */
export const RateLimit = (...rules: RateLimitRule[]): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_METADATA, rules);

/** What the guard reads of the request; `context` is set by the auth guard (RequestContext). */
type LimitedRequest = Request & { context?: { userId: string } };

function emailOf(req: LimitedRequest): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined;
}

/** The value a rule counts by. A missing email or signed-in user falls back to the IP (the caller is not known yet). */
function keyValue(rule: RateLimitRule, req: LimitedRequest): string {
  const ip = req.ip ?? 'unknown';
  switch (rule.key) {
    case 'ip':
      return ip;
    case 'email':
      return emailOf(req) ?? ip;
    case 'ip+email': {
      const email = emailOf(req);
      return email === undefined ? ip : `${ip}|${email}`;
    }
    case 'user':
      return req.context?.userId ?? ip;
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: FixedWindowLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const rules = this.reflector.getAllAndMerge<RateLimitRule[]>(RATE_LIMIT_METADATA, [context.getHandler(), context.getClass()]);
    if (!rules?.length) return true;
    const http = context.switchToHttp();
    const req = http.getRequest<LimitedRequest>();
    // Every rule is hit (no short-circuit), so one request spends from each of its counters.
    const results = rules.map((rule) => this.limiter.hit(`${rule.name}|${keyValue(rule, req)}`, rule.limit, rule.windowMs));
    const refused = results.filter((result) => !result.allowed);
    if (refused.length === 0) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(Math.max(...refused.map((result) => result.retryAfterSec))));
    throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many requests. Try again later.');
  }
}
