import { type MailEnv, mailEnvSchema, parseEnv } from '@rejectradar/contracts';
import { existsSync } from 'node:fs';

/**
 * Reads and validates the mail variables (`MAIL_*`, `RESEND_API_KEY`, `APP_ORIGIN`). Only `alerts:run` and `digest:send`
 * call it, and only when they send email, so the other commands never need these variables (P5-D12). Without an
 * explicit `source`, loads `.env` (when present) into `process.env` first and validates that.
 */
export function loadMailEnv(source?: NodeJS.ProcessEnv): MailEnv {
  if (source === undefined && existsSync('.env')) process.loadEnvFile('.env');
  return parseEnv(mailEnvSchema, source ?? process.env);
}
