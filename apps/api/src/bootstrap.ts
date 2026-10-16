import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ApiEnv } from '@rejectradar/contracts';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app/app.module';
import { ErrorFilter } from './common/errors';

export async function createApp(env: ApiEnv): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(env), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({ origin: env.APP_ORIGIN, credentials: true });
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  return app;
}
