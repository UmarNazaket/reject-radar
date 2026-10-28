import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  type CheckoutRequest,
  checkoutRequest,
  type CheckoutResponse,
  type PlansResponse,
  type SubscriptionResponse,
} from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, Public, RequireVerifiedEmail, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-pipe';
import { BillingService } from './billing.service';

/** Plans, subscription and checkout for the billing page. The price list is public; the subscription is any member's to read; only an owner buys. */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Get('plans')
  plans(): PlansResponse {
    return this.billing.plans();
  }

  @Get('subscription')
  subscription(@CurrentContext() ctx: RequestContext): Promise<SubscriptionResponse> {
    return this.billing.subscription(ctx);
  }

  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @Roles('owner')
  @RequireVerifiedEmail()
  checkout(
    @CurrentContext() ctx: RequestContext,
    @Body(new ZodValidationPipe(checkoutRequest)) body: CheckoutRequest,
  ): Promise<CheckoutResponse> {
    return this.billing.checkout(ctx, body);
  }
}
