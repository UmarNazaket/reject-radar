import { DrizzleQueryError } from 'drizzle-orm';
import { Writable } from 'node:stream';
import pino from 'pino';
import { errSerializer } from './logging';

/** What the serializer returns for an error: plain fields plus the serialised cause. */
interface Serialized {
  [key: string]: unknown;
  cause?: Serialized;
}

const withCause = (message: string, cause: unknown): Error => Object.assign(new Error(message), { cause });

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHRmYWtlc2FsdA$ZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWhhc2g';
const EMAIL = 'ayesha.khan@example.com';
const INSERT = 'insert into "app_user" ("id", "email", "password_hash") values ($1, $2, $3)';

/** A unique violation as node-postgres raises it: the detail repeats the email. */
function pgUniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint "app_user_email_idx"'), {
    code: '23505',
    constraint: 'app_user_email_idx',
    detail: `Key (lower(email))=(${EMAIL}) already exists.`,
    table: 'app_user',
  });
}

/** Drizzle's error around it, whose message, stack, `query` and `params` all carry the values; plus an outer wrapper. */
function drizzleChain(): Error {
  const inner = new DrizzleQueryError(INSERT, ['0199-uuid', EMAIL, HASH], pgUniqueViolation());
  return withCause('Sign-up failed', inner);
}

describe('errSerializer', () => {
  it('keeps the type, message, stack, code and constraint, and walks the cause chain', () => {
    const out = errSerializer(drizzleChain()) as Serialized;
    expect(out['type']).toBe('Error');
    expect(out['message']).toBe('Sign-up failed');
    expect(out['stack']).toContain('Sign-up failed');
    const drizzle = out.cause as Serialized;
    expect(drizzle.type).toBe('DrizzleQueryError');
    expect(drizzle.message).toBe(`Failed query: ${INSERT}`);
    expect(drizzle.stack).toMatch(/^Error: Failed query: insert into "app_user"/);
    expect(drizzle.stack).toMatch(/\n\s+at /);
    expect(drizzle).not.toHaveProperty('query');
    expect(drizzle).not.toHaveProperty('params');
    const pg = drizzle.cause;
    expect(pg).toMatchObject({ code: '23505', constraint: 'app_user_email_idx', message: expect.stringContaining('app_user_email_idx') });
    expect(pg).not.toHaveProperty('detail');
  });

  it('lets neither the hash nor the email through, at any level', () => {
    const text = JSON.stringify(errSerializer(drizzleChain()));
    expect(text).not.toContain(HASH);
    expect(text).not.toContain('ZmFrZWhhc2g');
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('params');
  });

  it('works on what pino-http hands it (the standard serializer output) and inside a real pino logger', () => {
    // pino-http wraps a custom err serializer, so it receives the standard serializer's output (which keeps `raw`)
    const wrapped = (err: unknown) => errSerializer(pino.stdSerializers.err(err as Error));
    expect(JSON.stringify(wrapped(drizzleChain()))).not.toContain(EMAIL);

    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    const logger = pino({ serializers: { err: wrapped } }, stream);
    logger.error({ err: drizzleChain() }, 'Request failed');
    logger.error(drizzleChain(), 'Bare error');
    const text = lines.join('');
    expect(text).toContain('Failed query: insert into');
    expect(text).toContain('23505');
    expect(text).not.toContain(HASH);
    expect(text).not.toContain(EMAIL);
  });

  it('passes a non-error value through and survives a cyclic cause', () => {
    expect(errSerializer('plain text')).toBe('plain text');
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = withCause('b', a);
    expect(() => JSON.stringify(errSerializer(a))).not.toThrow();
  });
});
