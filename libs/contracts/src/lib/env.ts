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

/** An origin such as https://app.example.com, normalised with `URL` (lowercase host, default port dropped, no trailing slash). */
const origin = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const reject = (message: string) => {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    };
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return reject('must be an origin such as https://app.example.com');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject('must start with http:// or https://');
    if (url.username || url.password) return reject('must not contain credentials');
    if (url.pathname !== '/' || value.includes('?') || value.includes('#')) {
      return reject('must be an origin such as https://app.example.com (no path, query or fragment)');
    }
    return url.origin;
  });

/** `Name <address>` or a bare address: goes into the From header, so no line breaks or stray angle brackets. */
const mailFrom = z
  .string()
  .trim()
  .refine(
    (value) => {
      const match = /^(?:[^<>\r\n]+<([^<>\s]+)>|([^<>\s]+))$/.exec(value);
      const address = match?.[1] ?? match?.[2];
      return address !== undefined && z.email().safeParse(address).success;
    },
    { message: 'must be an address such as alerts@example.com or "Name <alerts@example.com>"' },
  );

const databaseUrl = z
  .string()
  .trim()
  .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// connection string');

/** An optional credential: unset or blank means "not provided"; a value must not be a known placeholder. */
function optionalCredential(name: string, hint: string) {
  return z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || !(PLACEHOLDER.test(value) || PLACEHOLDER.test(value.replace(/^re_/i, ''))), {
      message: `${name} looks like a placeholder; ${hint}`,
    });
}

/** The refinements every environment that sends mail shares: the Resend key, and Resend only in production. */
function refineMailEnv(env: { NODE_ENV: string; MAIL_TRANSPORT: string; RESEND_API_KEY?: string | undefined }, ctx: z.RefinementCtx): void {
  if (env.MAIL_TRANSPORT === 'resend' && !env.RESEND_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'is required when MAIL_TRANSPORT=resend' });
  }
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT !== 'resend') {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_TRANSPORT'],
      message: 'must be "resend" in production (smtp is for local development)',
    });
  }
}

/** The variables the mailer reads: the API always, the ingest CLI only for `alerts:run` and `digest:send`. */
const mailEnvFields = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: origin,
  /** `smtp` posts to MAIL_SMTP_URL (Mailpit locally); `resend` uses the Resend API. Production allows only `resend`. */
  MAIL_TRANSPORT: z.enum(['smtp', 'resend']).default('smtp'),
  MAIL_SMTP_URL: z
    .string()
    .trim()
    .regex(/^smtps?:\/\/\S+$/, 'must be an smtp:// or smtps:// URL')
    .default('smtp://127.0.0.1:1025'),
  RESEND_API_KEY: optionalCredential('RESEND_API_KEY', 'use the key from the Resend dashboard or leave it empty'),
  MAIL_FROM: mailFrom,
});

export const mailEnvSchema = mailEnvFields.superRefine(refineMailEnv);

export type MailEnv = z.output<typeof mailEnvSchema>;

export const apiEnvSchema = z
  .object({
    ...mailEnvFields.shape,
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: strongSecret('JWT_SECRET'),
    /** Proxies between the client and the API whose X-Forwarded-For we trust, so `req.ip` is the client (P4-D14). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine(refineMailEnv);

export type ApiEnv = z.output<typeof apiEnvSchema>;

export const ingestEnvSchema = z.object({
  DATABASE_URL: databaseUrl,
  /** Goes into the User-Agent of every request so source operators can reach us (spec §6.3 rule 5). */
  INGEST_CONTACT_EMAIL: z.string().trim().pipe(z.email()),
  FDA_API_USER: optionalCredential('FDA_API_USER', 'use the credential FDA issued or leave it empty'),
  FDA_API_KEY: optionalCredential('FDA_API_KEY', 'use the credential FDA issued or leave it empty'),
  INGEST_FAILURE_DIR: z.string().trim().min(1).default('tmp/ingest-failures'),
});

export type IngestEnv = z.output<typeof ingestEnvSchema>;

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
