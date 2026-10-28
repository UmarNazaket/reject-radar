import { apiEnvSchema, EnvValidationError, ingestEnvSchema, parseEnv } from './env';

const SECRET = 'qL8vT2nX5rW9yB3mK7pD1sF6hJ4gZ0cA2eR8tY5uI3o'; // 43 chars, like `npm run secret`

const valid: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  PORT: '3100',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://rejectradar:rejectradar@localhost:5432/rejectradar',
  JWT_SECRET: SECRET,
  APP_ORIGIN: 'http://localhost:4200',
  MAIL_FROM: 'RejectRadar <test@rejectradar.test>',
  PADDLE_ENV: 'sandbox',
  PADDLE_API_KEY: `pdl_sdbx_apikey_${'t'.repeat(40)}`,
  PADDLE_CLIENT_TOKEN: `test_${'t'.repeat(27)}`,
  PADDLE_WEBHOOK_SECRET: SECRET,
  PADDLE_PRICE_PRO_MONTHLY: 'pri_01m61npvnr18pc5g8fjpjfnhne',
  PADDLE_PRICE_PRO_YEARLY: 'pri_01m61npw5hf8zddhzww39dmshg',
  PADDLE_PRICE_BUSINESS_MONTHLY: 'pri_01m61npx58trnyzg6z77vywvjk',
  PADDLE_PRICE_BUSINESS_YEARLY: 'pri_01m61npxms42vc5e3pr7r3na4q',
};

function errorFor(overrides: Record<string, string | undefined>): EnvValidationError {
  try {
    parseEnv(apiEnvSchema, { ...valid, ...overrides });
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('expected parseEnv to throw');
}

describe('apiEnvSchema', () => {
  it('parses a valid environment and coerces PORT to a number', () => {
    const env = parseEnv(apiEnvSchema, valid);
    expect(env.PORT).toBe(3100);
    expect(env.LOG_LEVEL).toBe('silent');
  });

  it('rejects a missing JWT_SECRET', () => {
    expect(errorFor({ JWT_SECRET: undefined }).message).toContain('JWT_SECRET');
  });

  it('rejects a JWT_SECRET shorter than 43 characters', () => {
    expect(errorFor({ JWT_SECRET: 'short-secret' }).message).toContain('at least 43 characters');
  });

  it('rejects the .env.example placeholder with a hint', () => {
    const error = errorFor({ JWT_SECRET: 'replace-with-output-of-npm-run-secret-xxxxxx' });
    expect(error.message).toContain('placeholder');
    expect(error.message).toContain('npm run secret');
  });

  it('trims whitespace around values', () => {
    const env = parseEnv(apiEnvSchema, {
      ...valid,
      JWT_SECRET: `  ${SECRET}  `,
      DATABASE_URL: ` ${valid['DATABASE_URL']} `,
    });
    expect(env.JWT_SECRET).toBe(SECRET);
    expect(env.DATABASE_URL).toBe(valid['DATABASE_URL']);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(errorFor({ DATABASE_URL: 'mysql://user@host/db' }).message).toContain('DATABASE_URL');
  });

  it('normalises APP_ORIGIN with URL', () => {
    const origin = (APP_ORIGIN: string) => parseEnv(apiEnvSchema, { ...valid, APP_ORIGIN }).APP_ORIGIN;
    expect(origin('HTTPS://App.Example.com/')).toBe('https://app.example.com');
    expect(origin('http://localhost:4200')).toBe('http://localhost:4200');
    expect(origin(' https://app.example.com ')).toBe('https://app.example.com');
  });

  it.each([
    ['a path', 'https://app.example.com/x'],
    ['credentials', 'https://u:p@app.example.com'],
    ['a query', 'https://app.example.com?a=1'],
    ['another scheme', 'ftp://x'],
    ['a non-URL', 'not a url'],
  ])('rejects an APP_ORIGIN with %s', (_label, APP_ORIGIN) => {
    expect(errorFor({ APP_ORIGIN }).message).toContain('APP_ORIGIN');
  });

  it('requires a Resend key for the resend transport', () => {
    const missing = errorFor({ MAIL_TRANSPORT: 'resend' });
    expect(missing.issues.some((issue) => issue.startsWith('RESEND_API_KEY'))).toBe(true);
    const placeholder = errorFor({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_placeholder' });
    expect(placeholder.issues.some((issue) => issue.startsWith('RESEND_API_KEY') && issue.includes('placeholder'))).toBe(true);
    const ok = parseEnv(apiEnvSchema, { ...valid, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: ' re_9fK2xQ7LmN4pR8sT ' });
    expect(ok.RESEND_API_KEY).toBe('re_9fK2xQ7LmN4pR8sT');
  });

  it('refuses smtp in production', () => {
    const error = errorFor({ NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp' });
    expect(error.issues.some((issue) => issue.startsWith('MAIL_TRANSPORT'))).toBe(true);
    const ok = parseEnv(apiEnvSchema, {
      ...valid,
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 're_9fK2xQ7LmN4pR8sT',
    });
    expect(ok.MAIL_TRANSPORT).toBe('resend');
  });

  it('defaults the mail transport to smtp on the local Mailpit', () => {
    const env = parseEnv(apiEnvSchema, valid);
    expect(env.MAIL_TRANSPORT).toBe('smtp');
    expect(env.MAIL_SMTP_URL).toBe('smtp://127.0.0.1:1025');
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it('rejects a MAIL_SMTP_URL that is not smtp:// or smtps://', () => {
    expect(errorFor({ MAIL_SMTP_URL: 'http://127.0.0.1:1025' }).message).toContain('MAIL_SMTP_URL');
  });

  it('requires MAIL_FROM', () => {
    expect(errorFor({ MAIL_FROM: undefined }).message).toContain('MAIL_FROM');
  });

  it.each(['RejectRadar <alerts@rejectradar.umarnazaket.com>', 'alerts@rejectradar.umarnazaket.com'])(
    'accepts MAIL_FROM %s',
    (MAIL_FROM) => {
      expect(parseEnv(apiEnvSchema, { ...valid, MAIL_FROM }).MAIL_FROM).toBe(MAIL_FROM);
    },
  );

  it.each(['RejectRadar <not-an-address>', 'just a name', 'Name <a@b.co> trailing'])('rejects MAIL_FROM %s', (MAIL_FROM) => {
    expect(errorFor({ MAIL_FROM }).message).toContain('MAIL_FROM');
  });

  it('defaults TRUST_PROXY_HOPS to 0 and bounds it to 0-5', () => {
    expect(parseEnv(apiEnvSchema, valid).TRUST_PROXY_HOPS).toBe(0);
    expect(parseEnv(apiEnvSchema, { ...valid, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
    expect(errorFor({ TRUST_PROXY_HOPS: '6' }).message).toContain('TRUST_PROXY_HOPS');
    expect(errorFor({ TRUST_PROXY_HOPS: '-1' }).message).toContain('TRUST_PROXY_HOPS');
    expect(errorFor({ TRUST_PROXY_HOPS: '1.5' }).message).toContain('TRUST_PROXY_HOPS');
  });

  it('reports every problem at once', () => {
    expect(errorFor({ JWT_SECRET: undefined, DATABASE_URL: undefined }).issues).toHaveLength(2);
  });

  it('ignores ingest-only variables such as FDA_API_KEY', () => {
    expect(() => parseEnv(apiEnvSchema, { ...valid, FDA_API_KEY: '' })).not.toThrow();
  });
});

describe('apiEnvSchema Paddle variables (P7-D10)', () => {
  const paddleNames = [
    'PADDLE_ENV',
    'PADDLE_API_KEY',
    'PADDLE_CLIENT_TOKEN',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_PRICE_PRO_MONTHLY',
    'PADDLE_PRICE_PRO_YEARLY',
    'PADDLE_PRICE_BUSINESS_MONTHLY',
    'PADDLE_PRICE_BUSINESS_YEARLY',
  ];

  it.each(paddleNames)('requires every Paddle variable: %s', (name) => {
    expect(errorFor({ [name]: undefined }).issues.some((issue) => issue.startsWith(`${name}:`))).toBe(true);
  });

  it('sandbox key must match PADDLE_ENV', () => {
    const production = { PADDLE_ENV: 'production', PADDLE_CLIENT_TOKEN: `live_${'t'.repeat(27)}` };
    const error = errorFor(production);
    expect(error.issues.some((issue) => issue.startsWith('PADDLE_API_KEY:'))).toBe(true);
    const env = parseEnv(apiEnvSchema, { ...valid, ...production, PADDLE_API_KEY: `pdl_live_apikey_${'t'.repeat(40)}` });
    expect(env.PADDLE_ENV).toBe('production');
    expect(errorFor({ PADDLE_API_KEY: `pdl_live_apikey_${'t'.repeat(40)}` }).issues.some((issue) => issue.startsWith('PADDLE_API_KEY:'))).toBe(true);
  });

  it('client token prefix follows PADDLE_ENV', () => {
    expect(parseEnv(apiEnvSchema, valid).PADDLE_CLIENT_TOKEN).toMatch(/^test_/);
    expect(errorFor({ PADDLE_CLIENT_TOKEN: `live_${'t'.repeat(27)}` }).issues.some((issue) => issue.startsWith('PADDLE_CLIENT_TOKEN:'))).toBe(true);
    const production = { PADDLE_ENV: 'production', PADDLE_API_KEY: `pdl_live_apikey_${'t'.repeat(40)}` };
    expect(errorFor({ ...production, PADDLE_CLIENT_TOKEN: `test_${'t'.repeat(27)}` }).issues.some((issue) => issue.startsWith('PADDLE_CLIENT_TOKEN:'))).toBe(true);
  });

  it('rejects a placeholder client token', () => {
    expect(errorFor({ PADDLE_CLIENT_TOKEN: 'test_replace_me' }).message).toContain('PADDLE_CLIENT_TOKEN');
  });

  it.each(['replace-me', 'pdl_ntfset_replace_me', 'changeme', ''])('rejects a placeholder webhook secret (%j)', (PADDLE_WEBHOOK_SECRET) => {
    expect(errorFor({ PADDLE_WEBHOOK_SECRET }).issues.some((issue) => issue.startsWith('PADDLE_WEBHOOK_SECRET:'))).toBe(true);
  });

  it('accepts a real-looking webhook secret', () => {
    const PADDLE_WEBHOOK_SECRET = `pdl_ntfset_01hkq3x0c4bz9m2v7n8d5e6f7g_${'a1B2'.repeat(8)}`;
    expect(parseEnv(apiEnvSchema, { ...valid, PADDLE_WEBHOOK_SECRET }).PADDLE_WEBHOOK_SECRET).toBe(PADDLE_WEBHOOK_SECRET);
  });

  it('price ids are checked', () => {
    expect(errorFor({ PADDLE_PRICE_PRO_MONTHLY: 'pri_123' }).issues.some((issue) => issue.startsWith('PADDLE_PRICE_PRO_MONTHLY:'))).toBe(true);
    expect(parseEnv(apiEnvSchema, valid).PADDLE_PRICE_PRO_MONTHLY).toBe('pri_01m61npvnr18pc5g8fjpjfnhne');
  });

  it('rejects an unknown PADDLE_ENV', () => {
    expect(errorFor({ PADDLE_ENV: 'staging' }).issues.some((issue) => issue.startsWith('PADDLE_ENV:'))).toBe(true);
  });

  it('staging may run NODE_ENV=production with PADDLE_ENV=sandbox', () => {
    const env = parseEnv(apiEnvSchema, {
      ...valid,
      NODE_ENV: 'production',
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 're_realLookingKey123',
      PADDLE_ENV: 'sandbox',
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.PADDLE_ENV).toBe('sandbox');
  });
});

describe('ingestEnvSchema', () => {
  const ingestValid: Record<string, string | undefined> = {
    DATABASE_URL: 'postgres://rejectradar:rejectradar@localhost:5432/rejectradar',
    INGEST_CONTACT_EMAIL: 'ops@example.com',
  };

  function ingestError(overrides: Record<string, string | undefined>): EnvValidationError {
    try {
      parseEnv(ingestEnvSchema, { ...ingestValid, ...overrides });
    } catch (error) {
      if (error instanceof EnvValidationError) return error;
      throw error;
    }
    throw new Error('expected parseEnv to throw');
  }

  it('parses a minimal environment and defaults INGEST_FAILURE_DIR', () => {
    const env = parseEnv(ingestEnvSchema, ingestValid);
    expect(env.INGEST_FAILURE_DIR).toBe('tmp/ingest-failures');
    expect(env.FDA_API_USER).toBeUndefined();
    expect(env.FDA_API_KEY).toBeUndefined();
  });

  it('rejects a missing INGEST_CONTACT_EMAIL', () => {
    expect(ingestError({ INGEST_CONTACT_EMAIL: undefined }).message).toContain('INGEST_CONTACT_EMAIL');
  });

  it('rejects INGEST_CONTACT_EMAIL that is not an email address', () => {
    expect(ingestError({ INGEST_CONTACT_EMAIL: 'not-an-email' }).message).toContain('INGEST_CONTACT_EMAIL');
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(ingestError({ DATABASE_URL: 'mysql://user@host/db' }).message).toContain('DATABASE_URL');
  });

  it('rejects a placeholder FDA_API_KEY', () => {
    expect(ingestError({ FDA_API_KEY: 'changeme' }).message).toContain('FDA_API_KEY');
  });

  it('treats empty FDA credentials as not set and trims real ones', () => {
    const empty = parseEnv(ingestEnvSchema, { ...ingestValid, FDA_API_USER: '', FDA_API_KEY: '  ' });
    expect(empty.FDA_API_USER).toBeUndefined();
    expect(empty.FDA_API_KEY).toBeUndefined();
    const set = parseEnv(ingestEnvSchema, { ...ingestValid, FDA_API_USER: ' u@example.com ', FDA_API_KEY: ' k3y ' });
    expect(set.FDA_API_USER).toBe('u@example.com');
    expect(set.FDA_API_KEY).toBe('k3y');
  });

  it('accepts an INGEST_FAILURE_DIR override', () => {
    expect(parseEnv(ingestEnvSchema, { ...ingestValid, INGEST_FAILURE_DIR: 'var/failures' }).INGEST_FAILURE_DIR).toBe('var/failures');
  });
});
