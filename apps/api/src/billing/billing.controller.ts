import { Controller, Get } from '@nestjs/common';
import type { PlansResponse, SubscriptionResponse } from '@rejectradar/contracts';
import type { RequestContext } from '../auth/context';
import { CurrentContext, Public } from '../auth/decorators';
import { BillingService } from './billing.service';

/** Plans and subscription for the billing page. The price list is public; the subscription is any member's to read. */
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
}
