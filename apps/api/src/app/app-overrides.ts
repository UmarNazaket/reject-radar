import type { MailTransport } from '@rejectradar/mail';

/** Seams the specs use to replace real infrastructure; production code never passes any. */
export interface AppOverrides {
  /** Replaces the transport chosen by MAIL_TRANSPORT (used by the mailer). */
  mailTransport?: MailTransport;
  /** Receives the request log lines instead of stdout, so a spec can read what was logged. */
  logStream?: NodeJS.WritableStream;
}
