import type { INestApplication } from '@nestjs/common';
import { apiEnvSchema, type ApiEnv, type Locale, parseEnv } from '@rejectradar/contracts';
import { appUser, type Database, membership, prepareTestDatabase } from '@rejectradar/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { AppOverrides } from '../app/app-overrides';
import { createApp } from '../bootstrap';
import { FixedWindowLimiter } from '../common/rate-limit';
import { DB } from '../database/database.module';
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

type Test = request.Test;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const UNSAFE_METHODS: ReadonlySet<Method> = new Set(['post', 'put', 'patch', 'delete']);

/**
 * A browser stand-in with its own cookie jar. Supertest agents drop `Secure` cookies over plain `http`, which is
 * how the specs reach the app, so this keeps the jar by hand.
 *
 * Every request carries the stored cookies, and the CSRF header on unsafe methods. The methods return the plain
 * supertest `Test`, so `.send()`, `.set()` and `.expect()` chain as usual; the cookies of each response are stored
 * from the `response` event the request emits, before the awaited result reaches the spec.
 */
export class TestSession {
  private readonly jar = new Map<string, string>();

  constructor(private readonly app: INestApplication) {}

  get(path: string): Test {
    return this.request('get', path);
  }
  post(path: string): Test {
    return this.request('post', path);
  }
  put(path: string): Test {
    return this.request('put', path);
  }
  patch(path: string): Test {
    return this.request('patch', path);
  }
  delete(path: string): Test {
    return this.request('delete', path);
  }

  /** The value of a stored cookie, or undefined when there is none (never set, expired or deleted). */
  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  private request(method: Method, path: string): Test {
    const test = request(this.app.getHttpServer())[method](path);
    if (this.jar.size > 0) test.set('Cookie', [...this.jar].map(([name, value]) => `${name}=${value}`).join('; '));
    if (UNSAFE_METHODS.has(method)) test.set('X-RejectRadar-CSRF', '1');
    test.on('response', (res: { headers: Record<string, unknown> }) => this.store(res.headers['set-cookie']));
    return test;
  }

  private store(header: unknown): void {
    const lines = Array.isArray(header) ? (header as string[]) : typeof header === 'string' ? [header] : [];
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const gone = attributes.some((attribute) => {
        const [key, value = ''] = attribute.split('=');
        const lower = key.toLowerCase();
        return (lower === 'max-age' && Number(value) <= 0) || (lower === 'expires' && Date.parse(value) <= Date.now());
      });
      if (gone) this.jar.delete(name);
      else this.jar.set(name, pair.slice(eq + 1));
    }
  }
}

export interface TestApp {
  app: INestApplication;
  db: Database;
  mail: FakeTransport;
  /** A new browser with an empty cookie jar. */
  session(): TestSession;
  /** Forgets every rate-limit window; each e2e spec calls it in `beforeEach`, because every request comes from one loopback IP. */
  resetRateLimits(): void;
  close(): Promise<void>;
}

/**
 * Boots the whole API on its own test database (`rejectradar_test_<suffix>`, wiped and migrated) with a fake mail
 * transport and `LOG_LEVEL=silent` (nestjs-pino keeps one logger per process). `suffix` must be unique to the spec file.
 */
export async function startTestApp(suffix: string, overrides: AppOverrides = {}): Promise<TestApp> {
  const url = await prepareTestDatabase(suffix);
  const mail = new FakeTransport();
  const app = await createApp(testEnv(url), { mailTransport: mail, ...overrides });
  await app.init();
  return {
    app,
    db: app.get<Database>(DB),
    mail,
    session: () => new TestSession(app),
    resetRateLimits: () => app.get(FixedWindowLimiter).reset(),
    close: () => app.close(),
  };
}

export interface NewAccount {
  email: string;
  name?: string;
  company?: string;
  locale?: Locale;
  password?: string;
}

/**
 * Signs an account up and opens the link in its verify email. Until the login route exists the returned session has
 * no cookies; it only carries the ids of the new user and account.
 */
export async function signUpVerified(
  t: TestApp,
  who: NewAccount,
): Promise<{ session: TestSession; userId: string; orgId: string }> {
  const session = t.session();
  await session
    .post('/v1/auth/signup')
    .send({
      name: who.name ?? 'Test User',
      email: who.email,
      password: who.password ?? 'zarfeen-rice-2026',
      companyName: who.company ?? 'Test Company',
      locale: who.locale ?? 'en',
    })
    .expect(202);
  const token = t.mail.linkIn(t.mail.lastTo(who.email)).searchParams.get('token');
  await session.post('/v1/auth/verify-email').send({ token }).expect(200);

  const [row] = await t.db
    .select({ userId: appUser.id, orgId: membership.orgId })
    .from(appUser)
    .innerJoin(membership, eq(membership.userId, appUser.id))
    .where(sql`lower(${appUser.email}) = ${who.email.trim().toLowerCase()}`);
  return { session, userId: row.userId, orgId: row.orgId };
}
