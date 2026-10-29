import { z } from 'zod';

/** Every public API key starts with this, so a leaked key is easy to recognise in logs and by secret scanners. */
export const API_KEY_PREFIX = 'rr_live_';
/** How many characters of a key are kept in clear to tell keys apart (`rr_live_` plus 4). */
export const API_KEY_DISPLAY_LENGTH = 12;
/** Live (not revoked) keys an account may hold at once. */
export const MAX_API_KEYS = 5;

/** `POST /v1/org/api-keys`. */
export const createApiKeyRequest = z.object({ name: z.string().trim().min(1).max(100) });
export type CreateApiKeyRequest = z.output<typeof createApiKeyRequest>;

/** One key as listed; the key itself is never shown again after it is created. Times are ISO 8601. */
export interface ApiKeyItem {
  id: string;
  name: string;
  /** The first characters of the key, such as `rr_live_AbCd`. */
  prefix: string;
  /** The name of the person who created the key; null once they are deleted. */
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeysResponse {
  keys: ApiKeyItem[];
}

/** The answer to a create: the only time `key` is ever returned. */
export interface CreatedApiKeyResponse extends ApiKeyItem {
  key: string;
}

/** `GET /v1/public/usage`: this UTC month's public API calls. */
export interface PublicUsageResponse {
  /** `YYYY-MM`. */
  period: string;
  apiCalls: { used: number; limit: number };
}
