import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ApiEnv } from '@rejectradar/contracts';
import { API_ENV } from '../config/env';

/** Fifteen minutes. A role change or removal still takes effect on the next request, because the guard reads the database (P4-D3). */
export const ACCESS_TOKEN_TTL_SEC = 900;

export interface AccessClaims {
  userId: string;
  orgId: string;
  /** The refresh-token family the session belongs to; a logged-out family stops its access tokens. */
  familyId: string;
}

interface AccessPayload {
  sub?: unknown;
  org?: unknown;
  fam?: unknown;
}

/** Signs and verifies the HS256 access JWT `{ sub, org, fam }` carried in the `rr_at` cookie. */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  sign(claims: AccessClaims): string {
    return this.jwt.sign(
      { sub: claims.userId, org: claims.orgId, fam: claims.familyId },
      { secret: this.env.JWT_SECRET, algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL_SEC },
    );
  }

  /** The claims of a valid token, or null for any failure: expired, malformed, forged, or another algorithm. Never throws. */
  verify(token: string): AccessClaims | null {
    try {
      const payload = this.jwt.verify<AccessPayload>(token, { secret: this.env.JWT_SECRET, algorithms: ['HS256'] });
      const { sub, org, fam } = payload;
      if (typeof sub !== 'string' || typeof org !== 'string' || typeof fam !== 'string') return null;
      return { userId: sub, orgId: org, familyId: fam };
    } catch {
      return null;
    }
  }
}
