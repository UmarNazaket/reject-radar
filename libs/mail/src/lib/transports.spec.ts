import { mailEnvSchema, parseEnv } from '@rejectradar/contracts';
import type { Resend } from 'resend';
import { createMailTransport, ResendTransport, SmtpTransport } from './transports';

/** A valid mail environment; `extra` overrides or adds variables. */
const testEnv = (extra: Record<string, string> = {}) =>
  parseEnv(mailEnvSchema, { NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:4200', MAIL_FROM: 'RejectRadar <test@rejectradar.test>', ...extra });

const message = { from: 'RejectRadar <a@rejectradar.test>', to: 'sara@example.com', subject: 'Hello', html: '<p>Hello</p>', text: 'Hello' };

function resendStub(result: unknown) {
  const send = jest.fn().mockResolvedValue(result);
  return { send, client: { emails: { send } } as unknown as Pick<Resend, 'emails'> };
}

describe('ResendTransport', () => {
  it('returns the id Resend assigned', async () => {
    const { client, send } = resendStub({ data: { id: 're_1' }, error: null });
    await expect(new ResendTransport(client).send(message)).resolves.toEqual({ providerId: 're_1' });
    expect(send).toHaveBeenCalledWith(message);
  });

  it('throws the error message Resend returned', async () => {
    const { client } = resendStub({ data: null, error: { message: 'bad' } });
    await expect(new ResendTransport(client).send(message)).rejects.toThrow('bad');
  });
});

describe('SmtpTransport', () => {
  it('passes the message to sendMail and returns its messageId', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<m1@rejectradar.test>' });
    await expect(new SmtpTransport({ sendMail }).send(message)).resolves.toEqual({ providerId: '<m1@rejectradar.test>' });
    expect(sendMail).toHaveBeenCalledWith({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  });

  it('lets an SMTP failure propagate', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('connection refused'));
    await expect(new SmtpTransport({ sendMail }).send(message)).rejects.toThrow('connection refused');
  });
});

describe('createMailTransport', () => {
  it('builds the SMTP transport by default', () => {
    expect(createMailTransport(testEnv())).toBeInstanceOf(SmtpTransport);
  });

  it('builds the Resend transport when MAIL_TRANSPORT=resend', () => {
    const env = testEnv({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test_ab12cd34ef56gh78' });
    expect(createMailTransport(env)).toBeInstanceOf(ResendTransport);
  });
});
