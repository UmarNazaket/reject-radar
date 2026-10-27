import { apiEnvSchema, type ApiEnv, parseEnv } from '@rejectradar/contracts';

const SECRET = 'qL8vT2nX5rW9yB3mK7pD1sF6hJ4gZ0cA2eR8tY5uI3o';

/** A valid API environment for specs; `extra` overrides or adds variables (for example `LOG_LEVEL`). */
export function testEnv(databaseUrl: string, extra: Record<string, string> = {}): ApiEnv {
  return parseEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    JWT_SECRET: SECRET,
    APP_ORIGIN: 'http://localhost:4200',
    MAIL_FROM: 'RejectRadar <test@rejectradar.test>',
    ...extra,
  });
}
