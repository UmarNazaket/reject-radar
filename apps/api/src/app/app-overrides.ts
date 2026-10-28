import type { MailTransport } from '@rejectradar/mail';
import type { PaddleGateway } from '../billing/paddle/gateway';

/** Seams the specs use to replace real infrastructure; production code never passes any. */
export interface AppOverrides {
  /** Replaces the transport chosen by MAIL_TRANSPORT (used by the mailer). */
  mailTransport?: MailTransport;
  /** Replaces the Paddle API client (portal sessions); specs never call Paddle. */
  paddleGateway?: PaddleGateway;
  /** Receives the request log lines instead of stdout, so a spec can read what was logged. */
  logStream?: NodeJS.WritableStream;
}
