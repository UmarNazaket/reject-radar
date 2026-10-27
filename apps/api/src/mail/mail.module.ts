import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { ApiEnv } from '@rejectradar/contracts';
import type { AppOverrides } from '../app/app-overrides';
import { MailerService } from './mailer.service';
import { createMailTransport, MAIL_TRANSPORT } from './transports';

@Global()
@Module({})
export class MailModule {
  static register(env: ApiEnv, overrides: Pick<AppOverrides, 'mailTransport'> = {}): DynamicModule {
    return {
      module: MailModule,
      providers: [{ provide: MAIL_TRANSPORT, useFactory: () => overrides.mailTransport ?? createMailTransport(env) }, MailerService],
      exports: [MailerService],
    };
  }
}
