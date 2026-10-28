import type { MailEnv } from '@rejectradar/contracts';
import { createTransport, type Transporter } from 'nodemailer';
import { Resend } from 'resend';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<{ providerId: string | null }>;
}

/** SMTP through nodemailer: Mailpit in development, any SMTP relay elsewhere. */
export class SmtpTransport implements MailTransport {
  constructor(private readonly transporter: Pick<Transporter, 'sendMail'>) {}

  async send(message: MailMessage): Promise<{ providerId: string | null }> {
    const { from, to, subject, html, text } = message;
    const info = await this.transporter.sendMail({ from, to, subject, html, text });
    return { providerId: info.messageId ?? null };
  }
}

/** The Resend HTTP API (production). The SDK returns failures instead of throwing, so this turns them into errors. */
export class ResendTransport implements MailTransport {
  constructor(private readonly client: Pick<Resend, 'emails'>) {}

  async send(message: MailMessage): Promise<{ providerId: string | null }> {
    const { from, to, subject, html, text } = message;
    const { data, error } = await this.client.emails.send({ from, to, subject, html, text });
    if (error) throw new Error(error.message);
    return { providerId: data?.id ?? null };
  }
}

export function createMailTransport(env: MailEnv): MailTransport {
  if (env.MAIL_TRANSPORT === 'resend') {
    // The env schema already requires the key whenever MAIL_TRANSPORT=resend.
    return new ResendTransport(new Resend(env.RESEND_API_KEY));
  }
  return new SmtpTransport(createTransport(env.MAIL_SMTP_URL));
}
