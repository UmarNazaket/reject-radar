import { type DynamicModule, Module } from '@nestjs/common';
import type { ApiEnv } from '@rejectradar/contracts';
import { LoggerModule } from 'nestjs-pino';
import { requestIdFor } from '../common/request-id';
import { API_ENV } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { HealthModule } from '../health/health.module';

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            genReqId: requestIdFor,
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
            transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
          },
        }),
        DatabaseModule.register(env.DATABASE_URL),
        HealthModule,
      ],
      providers: [{ provide: API_ENV, useValue: env }],
      exports: [API_ENV],
    };
  }
}
