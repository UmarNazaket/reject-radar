import { Controller, Headers, HttpCode, HttpStatus, Post, type RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public, SkipCsrf } from '../auth/decorators';
import { AppError } from '../common/errors';
import { PaddleWebhookService } from './paddle-webhook.service';
import { PaymentFailedNotifier } from './payment-failed.notifier';

/** Paddle's notifications (spec §10.2). No session and no CSRF header: the `Paddle-Signature` over the raw body is the check. */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: PaddleWebhookService,
    private readonly paymentFailed: PaymentFailedNotifier,
  ) {}

  @Public()
  @SkipCsrf()
  @Post('paddle')
  @HttpCode(HttpStatus.OK)
  async paddle(@Req() req: RawBodyRequest<Request>, @Headers('paddle-signature') signature: string | undefined): Promise<{ received: true }> {
    // Only the JSON body parser keeps the raw bytes; any other content type leaves nothing to check the signature against.
    if (!req.rawBody) throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_SIGNATURE', 'The Paddle signature does not match the body');
    const { pastDueOrgIds } = await this.webhooks.receive(req.rawBody, signature);
    // The transaction has committed. The emails are best effort (P7-D7): `notify` logs its own failures, and nothing it does may make Paddle retry an event that has been applied.
    await this.paymentFailed.notify(pastDueOrgIds);
    return { received: true };
  }
}
