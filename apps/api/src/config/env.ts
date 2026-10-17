import { apiEnvSchema, type ApiEnv, parseEnv } from '@rejectradar/contracts';

export const API_ENV = Symbol('API_ENV');

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return parseEnv(apiEnvSchema, source);
}
