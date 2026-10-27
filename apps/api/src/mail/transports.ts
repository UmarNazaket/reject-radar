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
