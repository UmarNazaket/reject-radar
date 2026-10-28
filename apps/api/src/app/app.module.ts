import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ApiEnv } from '@rejectradar/contracts';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { AuthModule } from '../auth/auth.module';
import type { ContextRequest } from '../auth/context';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VerifiedEmailGuard } from '../auth/guards/verified-email.guard';
import { errSerializer, reqSerializer, resSerializer } from '../common/logging';
import { FixedWindowLimiter, RateLimitGuard } from '../common/rate-limit';
import { requestIdFor } from '../common/request-id';
import { API_ENV } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { FirmsModule } from '../firms/firms.module';
import { HealthModule } from '../health/health.module';
import { MailModule } from '../mail/mail.module';
import { NoticesModule } from '../notices/notices.module';
import { OrgsModule } from '../orgs/orgs.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import type { AppOverrides } from './app-overrides';

function pinoOptions(env: ApiEnv, allowTransport: boolean): Options {
  return {
    level: env.LOG_LEVEL,
    genReqId: requestIdFor,
    // Every logger shares these, Nest's `Logger` included (nestjs-pino), so `{ err }` never carries query params.
    serializers: { req: reqSerializer, res: resSerializer, err: errSerializer },
    // The serializers already drop these; redaction stays as a second guard.
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    // pino-http evaluates this at request start and again when the response finishes, by which time AuthGuard has set the context.
    // Public calls log no user.
    customProps: (req) => {
      const ctx = (req as ContextRequest).context;
      return ctx ? { userId: ctx.userId, orgId: ctx.orgId } : {};
    },
    // A transport and a custom destination stream cannot be combined, so the pretty printer only runs on stdout.
    transport: allowTransport && env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
  };
}

@Module({})
export class AppModule {
  static register(env: ApiEnv, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot({ pinoHttp: overrides.logStream ? [pinoOptions(env, false), overrides.logStream] : pinoOptions(env, true) }),
        DatabaseModule.register(env.DATABASE_URL),
        MailModule.register(env, overrides),
        AuthModule,
        EntitlementsModule,
        FirmsModule,
        HealthModule,
        NoticesModule,
        OrgsModule,
        TaxonomyModule,
      ],
      providers: [
        { provide: API_ENV, useValue: env },
        FixedWindowLimiter,
        // Guards run in this order, and all before pipes. The rate limiter is last so its `user` key can read the context.
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: VerifiedEmailGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
      exports: [API_ENV],
    };
  }
}
