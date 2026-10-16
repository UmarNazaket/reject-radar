import { EnvValidationError } from '@rejectradar/contracts';
import { existsSync } from 'node:fs';
import { createApp } from './bootstrap';
import { loadApiEnv } from './config/env';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  let env;
  try {
    env = loadApiEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message); // spec §12: refuse to start on missing or placeholder secrets
      process.exit(1);
    }
    throw error;
  }
  const app = await createApp(env);
  await app.listen(env.PORT);
}

void main();
