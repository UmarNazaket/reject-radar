import { apiEnvSchema, type ApiEnv, parseEnv } from '@rejectradar/contracts';
import type { MailMessage, MailTransport } from '../mail/transports';

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

/** Stands in for the mail provider: records what the mailer sends, and can be told to fail the next send. */
export class FakeTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  private failure: Error | null = null;

  /** The next `send` rejects with `error`; the ones after it succeed again. */
  failNext(error: Error): void {
    this.failure = error;
  }

  async send(message: MailMessage): Promise<{ providerId: string | null }> {
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    this.sent.push(message);
    return { providerId: `fake-${this.sent.length}` };
  }

  /** The latest message sent to `email`; throws when there is none. */
  lastTo(email: string): MailMessage {
    const wanted = email.trim().toLowerCase();
    const message = [...this.sent].reverse().find((m) => m.to.trim().toLowerCase() === wanted);
    if (!message) throw new Error(`No email was sent to ${email} (sent to: ${this.sent.map((m) => m.to).join(', ') || 'nobody'})`);
    return message;
  }

  /** The first link in the plain-text body, which is how a spec follows a verification, reset or invite email. */
  linkIn(message: MailMessage): URL {
    const match = /https?:\/\/\S+/.exec(message.text);
    if (!match) throw new Error('The email has no link');
    return new URL(match[0]);
  }
}
