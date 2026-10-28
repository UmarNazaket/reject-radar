import { EnvValidationError } from '@rejectradar/contracts';
import { loadMailEnv } from './mail-env';

const BASE = { APP_ORIGIN: 'https://app.test', MAIL_FROM: 'RejectRadar <alerts@app.test>' };

describe('loadMailEnv', () => {
  it('reads the mail variables and defaults the rest', () => {
    expect(loadMailEnv(BASE)).toMatchObject({ APP_ORIGIN: 'https://app.test', MAIL_TRANSPORT: 'smtp', MAIL_SMTP_URL: 'smtp://127.0.0.1:1025' });
  });

  it('refuses a missing origin or sender', () => {
    expect(() => loadMailEnv({})).toThrow(EnvValidationError);
    expect(() => loadMailEnv({ MAIL_FROM: BASE.MAIL_FROM })).toThrow(/APP_ORIGIN/);
  });

  it('wants the Resend key for Resend, and Resend in production', () => {
    expect(() => loadMailEnv({ ...BASE, MAIL_TRANSPORT: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(() => loadMailEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(/resend/);
    expect(loadMailEnv({ ...BASE, NODE_ENV: 'production', MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_live_abc123' }).MAIL_TRANSPORT).toBe('resend');
  });
});
