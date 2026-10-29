import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ApiEnv } from '@rejectradar/contracts';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { AlertsModule } from '../alerts/alerts.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuthModule } from '../auth/auth.module';
import type { ApiKeyRequest, ContextRequest } from '../auth/context';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VerifiedEmailGuard } from '../auth/guards/verified-email.guard';
import { BillingModule } from '../billing/billing.module';
import { BulkModule } from '../bulk/bulk.module';
import { errSerializer, reqSerializer, resSerializer } from '../common/logging';
import { FixedWindowLimiter, RateLimitGuard } from '../common/rate-limit';
import { requestIdFor } from '../common/request-id';
import { API_ENV } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { FirmsModule } from '../firms/firms.module';
import { HealthModule } from '../health/health.module';
import { MailModule } from '../mail/mail.module';
import { ImportAlertsModule } from '../import-alerts/import-alerts.module';
import { MrlModule } from '../mrl/mrl.module';
import { NoticesModule } from '../notices/notices.module';
import { OrgsModule } from '../orgs/orgs.module';
import { PublicApiModule } from '../public-api/public-api.module';
import { ReportsModule } from '../reports/reports.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { WatchlistsModule } from '../watchlists/watchlists.module';
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
    // Public calls log no user; public API calls log their key's id, never the key.
    customProps: (req) => {
      const ctx = (req as ContextRequest).context;
      if (ctx) return { userId: ctx.userId, orgId: ctx.orgId };
      const key = (req as ApiKeyRequest).apiKey;
      return key ? { keyId: key.keyId, orgId: key.orgId } : {};
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
        AlertsModule,
        ApiKeysModule,
        AuthModule,
        BillingModule.register(env, overrides),
        BulkModule,
        EntitlementsModule,
        FirmsModule,
        HealthModule,
        ImportAlertsModule,
        MrlModule,
        NoticesModule,
        OrgsModule,
        PublicApiModule,
        ReportsModule,
        TaxonomyModule,
        WatchlistsModule,
      ],
      providers: [
        { provide: API_ENV, useValue: env },
        FixedWindowLimiter,
        // Guards run in this order, and all before pipes. The rate limiter is last so its `user` and `apiKey` keys can read what the others set.
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: VerifiedEmailGuard },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
      exports: [API_ENV],
    };
  }
}
