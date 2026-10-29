import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ApiEnv } from '@rejectradar/contracts';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { AppOverrides } from './app/app-overrides';
import { AppModule } from './app/app.module';
import { ErrorFilter } from './common/errors';

export async function createApp(env: ApiEnv, overrides: AppOverrides = {}): Promise<INestApplication> {
  // `rawBody` keeps the bytes the JSON parser read on `req.rawBody`; the Paddle webhook signature is checked over them.
  const app = await NestFactory.create(AppModule.register(env, overrides), { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  // Behind Cloudflare and Render's proxy, trust the forwarded client address so req.ip (and the per-IP limits) see the client (P4-D14).
  if (env.TRUST_PROXY_HOPS > 0) app.getHttpAdapter().getInstance().set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: env.APP_ORIGIN, credentials: true });
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  return app;
}
