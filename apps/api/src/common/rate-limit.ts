import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, Optional, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AppError } from './errors';

export interface RateLimitRule {
  /** Unique per limit; it prefixes the counter key, so two routes never share a counter. */
  name: string;
  limit: number;
  windowMs: number;
  key: 'ip' | 'ip+email' | 'email' | 'user' | 'apiKey';
}

export interface LimitResult {
  allowed: boolean;
  /** Whole seconds until the window ends; 0 when the hit was allowed. */
  retryAfterSec: number;
}

/** Entries whose window has passed are swept at most this often, so a key that is never seen again does not linger. */
const SWEEP_INTERVAL_MS = 60_000;
/**
 * Hard ceiling on live counters, so memory stays bounded however many distinct keys arrive. 100,000 keys of at most a
 * few hundred characters each are tens of megabytes. At the ceiling a new key evicts the oldest counter rather than
 * being refused: refusing would let one caller fill the map and lock every other caller out.
 */
const MAX_KEYS = 100_000;
/** Optional provider that overrides the ceiling; tests pass a small one to the constructor instead. */
export const RATE_LIMIT_MAX_KEYS = Symbol('RATE_LIMIT_MAX_KEYS');

/** One counter a request spends from: its key, how many hits the window allows and how long the window is. */
export interface LimitHit {
  key: string;
  limit: number;
  windowMs: number;
}

/**
 * In-memory fixed-window counter. The window opens at a key's first hit and its counter is dropped once the window
 * has passed. State is per process: a restart only resets the windows (P4-D5).
 *
 * A request is checked against all of its counters before any is written (`hitAll`), so a refused request creates no
 * counter and spends none. The map is kept in order of window start (a key whose window restarts moves to the end),
 * so when it is full the first key is the oldest counter and is the one evicted to make room.
 */
@Injectable()
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep: number | undefined;

  constructor(@Optional() @Inject(RATE_LIMIT_MAX_KEYS) private readonly maxKeys: number = MAX_KEYS) {}

  /** One counter; the same as `hitAll` with a single hit. */
  hit(key: string, limit: number, windowMs: number, now: number = Date.now()): LimitResult {
    return this.hitAll([{ key, limit, windowMs }], now);
  }

  /**
   * Spends one hit from every counter, or none. If any counter has a live window that is already at its limit, nothing
   * is written and the answer carries the longest time left among the refusing windows. Otherwise each counter opens
   * a fresh window (when it has none or its window has passed) and is incremented.
   */
  hitAll(hits: readonly LimitHit[], now: number = Date.now()): LimitResult {
    this.sweep(now);
    let retryAfterSec = 0;
    for (const { key, limit } of hits) {
      const entry = this.windows.get(key);
      if (entry !== undefined && entry.resetAt > now && entry.count >= limit) {
        retryAfterSec = Math.max(retryAfterSec, Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
      }
    }
    if (retryAfterSec > 0) return { allowed: false, retryAfterSec };

    for (const { key, windowMs } of hits) {
      let entry = this.windows.get(key);
      if (entry === undefined || entry.resetAt <= now) entry = this.open(key, now + windowMs);
      entry.count += 1;
    }
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

  /** Starts a window for the key as the newest entry, evicting the oldest counter first when the map is full. */
  private open(key: string, resetAt: number): { count: number; resetAt: number } {
    this.windows.delete(key); // an expired entry is replaced; deleting first keeps insertion order meaningful
    if (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (!oldest.done) this.windows.delete(oldest.value);
    }
    const entry = { count: 0, resetAt };
    this.windows.set(key, entry);
    return entry;
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

/** What the guard reads of the request; `context` is set by the auth guard (RequestContext), `apiKey` by the API key guard. */
type LimitedRequest = Request & { context?: { userId: string }; apiKey?: { keyId: string } };

/** The longest address a valid request can carry (RFC 5321 path limit); anything longer is junk. */
const MAX_EMAIL_LENGTH = 254;
/**
 * Shared key for an email that cannot be valid. Guards run before the zod pipe, so the raw body value would otherwise
 * become part of a key kept for the whole window; junk is still counted, collectively.
 */
const INVALID_EMAIL = '(invalid)';

/** The trimmed, lowercased email; `undefined` when the body has none, `(invalid)` when it is not a plausible one. */
function emailOf(req: LimitedRequest): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  if (email === undefined) return undefined;
  if (typeof email !== 'string') return INVALID_EMAIL;
  const normalised = email.trim().toLowerCase();
  return normalised.length > MAX_EMAIL_LENGTH ? INVALID_EMAIL : normalised;
}

/** The value a rule counts by. A missing email, signed-in user or API key falls back to the IP (the caller is not known yet). */
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
    case 'apiKey':
      return req.apiKey?.keyId ?? ip;
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
    // All rules are checked together: a refused request spends from none of its counters and creates none.
    const result = this.limiter.hitAll(rules.map((rule) => ({ key: `${rule.name}|${keyValue(rule, req)}`, limit: rule.limit, windowMs: rule.windowMs })));
    if (result.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(result.retryAfterSec));
    throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many requests. Try again later.');
  }
}
