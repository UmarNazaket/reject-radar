import { ingestEnvSchema, parseEnv, type IngestEnv } from '@rejectradar/contracts';
import { existsSync } from 'node:fs';

/**
 * Reads and validates the ingest environment. Without an explicit `source`, loads `.env` (when present) into
 * `process.env` first and validates that.
 */
export function loadIngestEnv(source?: Record<string, string | undefined>): IngestEnv {
  if (source === undefined && existsSync('.env')) process.loadEnvFile('.env');
  return parseEnv(ingestEnvSchema, source ?? process.env);
}
