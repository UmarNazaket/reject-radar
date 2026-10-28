import type { ApiEnv } from '@rejectradar/contracts';
import type { CookieOptions, Response } from 'express';
import { ACCESS_TOKEN_TTL_SEC } from './access-tokens';

export const ACCESS_COOKIE = 'rr_at';
export const REFRESH_COOKIE = 'rr_rt';

/** Thirty days; the cookie and the `refresh_token.expires_at` share it. */
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

type Kind = 'access' | 'refresh';

const COOKIE_NAME: Record<Kind, string> = { access: ACCESS_COOKIE, refresh: REFRESH_COOKIE };

/**
 * Host-only (no `Domain`), `HttpOnly`, `SameSite=Lax`, and `Secure` everywhere except local development. The refresh
 * cookie is only sent to `/v1/auth`, so ordinary API calls never carry it.
 */
export function cookieOptions(env: Pick<ApiEnv, 'NODE_ENV'>, kind: Kind): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development',
    sameSite: 'lax',
    path: kind === 'access' ? '/' : '/v1/auth',
    // Express takes milliseconds and writes whole seconds into Max-Age.
    maxAge: (kind === 'access' ? ACCESS_TOKEN_TTL_SEC : REFRESH_TOKEN_TTL_SEC) * 1000,
  };
}

export function setSessionCookies(res: Response, env: Pick<ApiEnv, 'NODE_ENV'>, access: string, refresh: string): void {
  res.cookie(ACCESS_COOKIE, access, cookieOptions(env, 'access'));
  res.cookie(REFRESH_COOKIE, refresh, cookieOptions(env, 'refresh'));
}

/** Expires both cookies with the same attributes they were set with (a browser matches on name, host and Path), `Max-Age=0`. */
export function clearSessionCookies(res: Response, env: Pick<ApiEnv, 'NODE_ENV'>): void {
  for (const kind of ['access', 'refresh'] as const) {
    res.cookie(COOKIE_NAME[kind], '', { ...cookieOptions(env, kind), maxAge: 0 });
  }
}
