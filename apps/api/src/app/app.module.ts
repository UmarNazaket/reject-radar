import { type DynamicModule, Module } from '@nestjs/common';
import type { ApiEnv } from '@rejectradar/contracts';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { reqSerializer, resSerializer } from '../common/logging';
import { requestIdFor } from '../common/request-id';
import { API_ENV } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { HealthModule } from '../health/health.module';
import { MailModule } from '../mail/mail.module';
import type { AppOverrides } from './app-overrides';

function pinoOptions(env: ApiEnv, allowTransport: boolean): Options {
  return {
    level: env.LOG_LEVEL,
    genReqId: requestIdFor,
    serializers: { req: reqSerializer, res: resSerializer },
    // The serializers already drop these; redaction stays as a second guard.
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
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
        HealthModule,
      ],
      providers: [{ provide: API_ENV, useValue: env }],
      exports: [API_ENV],
    };
  }
}
