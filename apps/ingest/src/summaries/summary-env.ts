import { parseEnv, type SummaryEnv, summaryEnvSchema } from '@rejectradar/contracts';
import { existsSync } from 'node:fs';

/**
 * Reads and validates the Gemini variables. Only `summaries:draft` and `summaries:translate` call it. Without an explicit
 * `source`, loads `.env` (when present) into `process.env` first and validates that.
 */
export function loadSummaryEnv(source?: NodeJS.ProcessEnv): SummaryEnv {
  if (source === undefined && existsSync('.env')) process.loadEnvFile('.env');
  return parseEnv(summaryEnvSchema, source ?? process.env);
}
