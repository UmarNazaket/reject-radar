import { type DynamicModule, Module } from '@nestjs/common';
import type { ApiEnv } from '@rejectradar/contracts';
import type { AppOverrides } from '../app/app-overrides';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { OrgsModule } from '../orgs/orgs.module';
import { WatchlistsModule } from '../watchlists/watchlists.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PaymentFailedNotifier } from './payment-failed.notifier';
import { PADDLE_GATEWAY, SdkPaddleGateway } from './paddle/gateway';
import { PaddleWebhookService } from './paddle-webhook.service';
import { WebhooksController } from './webhooks.controller';

@Module({})
export class BillingModule {
  static register(env: ApiEnv, overrides: Pick<AppOverrides, 'paddleGateway'> = {}): DynamicModule {
    return {
      module: BillingModule,
      imports: [EntitlementsModule, OrgsModule, WatchlistsModule],
      controllers: [BillingController, WebhooksController],
      providers: [BillingService, PaddleWebhookService, PaymentFailedNotifier, { provide: PADDLE_GATEWAY, useFactory: () => overrides.paddleGateway ?? new SdkPaddleGateway(env) }],
      exports: [PADDLE_GATEWAY],
    };
  }
}
