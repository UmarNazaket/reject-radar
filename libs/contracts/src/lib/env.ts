import { z } from 'zod';

const PLACEHOLDER = /^(change[-_ ]?me.*|replace[-_ ].*|your[-_ ].*|secret|password|placeholder|default|x+)$/i;

/** A secret of at least 32 random bytes (43 base64url characters) that is not a known placeholder. */
export function strongSecret(name: string) {
  return z
    .string()
    .trim()
    .min(43, `${name} must be at least 43 characters (32 random bytes); generate one with "npm run secret"`)
    .refine((value) => !PLACEHOLDER.test(value), {
      message: `${name} looks like a placeholder; generate one with "npm run secret"`,
    });
}

const origin = z
  .string()
  .trim()
  .transform((value) => value.replace(/\/+$/, ''))
  .refine((value) => /^https?:\/\/[^/\s]+$/.test(value), {
    message: 'must be an origin such as https://app.example.com (no path)',
  });

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z
    .string()
    .trim()
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// connection string'),
  JWT_SECRET: strongSecret('JWT_SECRET'),
  APP_ORIGIN: origin,
});

export type ApiEnv = z.output<typeof apiEnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined>,
): z.output<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
