import type { INestApplication } from '@nestjs/common';
import { apiEnvSchema, type ApiEnv, type InviteRole, type Locale, parseEnv, type PlanId } from '@rejectradar/contracts';
import { appUser, type Database, membership, org, prepareTestDatabase } from '@rejectradar/db';
import type { MailMessage, MailTransport } from '@rejectradar/mail';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { AppOverrides } from '../app/app-overrides';
import { createApp } from '../bootstrap';
import { FixedWindowLimiter } from '../common/rate-limit';
import { DB } from '../database/database.module';
import { FakePaddleGateway } from './paddle-fixtures';

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
    PADDLE_ENV: 'sandbox',
    PADDLE_API_KEY: `pdl_sdbx_apikey_${'t'.repeat(40)}`,
    PADDLE_CLIENT_TOKEN: `test_${'t'.repeat(27)}`,
    PADDLE_WEBHOOK_SECRET: SECRET,
    PADDLE_PRICE_PRO_MONTHLY: 'pri_01m61npvnr18pc5g8fjpjfnhne',
    PADDLE_PRICE_PRO_YEARLY: 'pri_01m61npw5hf8zddhzww39dmshg',
    PADDLE_PRICE_BUSINESS_MONTHLY: 'pri_01m61npx58trnyzg6z77vywvjk',
    PADDLE_PRICE_BUSINESS_YEARLY: 'pri_01m61npxms42vc5e3pr7r3na4q',
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

  constructor(private readonly app: Pick<INestApplication, 'getHttpServer'>) {}

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
    if (UNSAFE_METHODS.has(method)) test.set('X-RejectRadar-CSRF', '1');
    // The Cookie header is built when the request is sent, not when it is created, so a request created before an
    // earlier response arrived still carries that response's cookies. A spec that sets `Cookie` itself keeps its value.
    const end = test.end.bind(test) as Test['end'];
    test.end = (callback) => {
      if (this.jar.size > 0 && test.get('Cookie') === undefined) {
        test.set('Cookie', [...this.jar].map(([name, value]) => `${name}=${value}`).join('; '));
      }
      return end(callback);
    };
    test.on('response', (res: { headers: Record<string, unknown> }) => this.store(res.headers['set-cookie']));
    return test;
  }

  private store(header: unknown): void {
    const lines = Array.isArray(header) ? (header as string[]) : typeof header === 'string' ? [header] : [];
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const gone = attributes.some((attribute) => {
        const [key, value = ''] = attribute.split('=');
        const lower = key.toLowerCase();
        return (lower === 'max-age' && Number(value) <= 0) || (lower === 'expires' && Date.parse(value) <= Date.now());
      });
      if (gone) this.jar.delete(name);
      else this.jar.set(name, pair.slice(separator + 1));
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
 * transport, a fake Paddle gateway (so no e2e boot can reach the real Paddle API) and `LOG_LEVEL=silent` (nestjs-pino keeps
 * one logger per process). `suffix` must be unique to the spec file.
 * `env` overrides or adds variables, as `testEnv`'s `extra` does (a spec that reads the logs sets `LOG_LEVEL`).
 */
export async function startTestApp(suffix: string, overrides: AppOverrides = {}, env: Record<string, string> = {}): Promise<TestApp> {
  const url = await prepareTestDatabase(suffix);
  const mail = new FakeTransport();
  const app = await createApp(testEnv(url, env), { mailTransport: mail, paddleGateway: new FakePaddleGateway(), ...overrides });
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
 * Signs an account up, opens the link in its verify email and logs in. The returned session carries the `rr_at` and
 * `rr_rt` cookies of a verified owner; `userId` and `orgId` are the ids of the new user and account.
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
  await session
    .post('/v1/auth/login')
    .send({ email: who.email, password: who.password ?? 'zarfeen-rice-2026' })
    .expect(200);

  const [row] = await t.db
    .select({ userId: appUser.id, orgId: membership.orgId })
    .from(appUser)
    .innerJoin(membership, eq(membership.userId, appUser.id))
    .where(and(sql`lower(${appUser.email}) = ${who.email.trim().toLowerCase()}`, eq(membership.role, 'owner')));
  return { session, userId: row.userId, orgId: row.orgId };
}

/** Puts an account on `plan` through `org.plan_override`, which wins over any subscription. Specs that invite teammates need more than the free plan's one seat. */
export async function setPlan(t: TestApp, orgId: string, plan: PlanId): Promise<void> {
  await t.db.update(org).set({ planOverride: plan }).where(eq(org.id, orgId));
}

export interface NewMember {
  email: string;
  role: InviteRole;
  name?: string;
  password?: string;
  locale?: Locale;
}

/**
 * Has `owner` (a signed-in session of an owner or admin) invite `who`, follows the link in the invite email and
 * accepts as a new person. The returned session is logged in as the new member.
 */
export async function joinByInvite(
  t: TestApp,
  owner: TestSession,
  who: NewMember,
): Promise<{ session: TestSession; userId: string; token: string }> {
  await owner.post('/v1/org/invites').send({ email: who.email, role: who.role }).expect(201);
  const token = t.mail.linkIn(t.mail.lastTo(who.email)).pathname.split('/').pop() as string;
  const session = t.session();
  const res = await session
    .post('/v1/invites/accept')
    .send({ token, name: who.name ?? 'Invited Person', password: who.password ?? 'basmati-export-77', locale: who.locale })
    .expect(200);
  return { session, userId: (res.body as { user: { id: string } }).user.id, token };
}
