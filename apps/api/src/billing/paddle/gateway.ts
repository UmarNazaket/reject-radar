import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import type { ApiEnv } from '@rejectradar/contracts';

/** What the API needs from Paddle's REST API. Specs replace it through `AppOverrides.paddleGateway`. */
export interface PaddleGateway {
  /** Opens a customer-portal session and returns the URL of its overview page. */
  createPortalSession(customerId: string, subscriptionIds: string[]): Promise<string>;
}

/** Injection token for the Paddle gateway. */
export const PADDLE_GATEWAY = Symbol('PADDLE_GATEWAY');

export class SdkPaddleGateway implements PaddleGateway {
  private readonly paddle: Paddle;

  constructor(env: Pick<ApiEnv, 'PADDLE_API_KEY' | 'PADDLE_ENV'>) {
    this.paddle = new Paddle(env.PADDLE_API_KEY, { environment: env.PADDLE_ENV === 'sandbox' ? Environment.sandbox : Environment.production });
  }

  async createPortalSession(customerId: string, subscriptionIds: string[]): Promise<string> {
    const session = await this.paddle.customerPortalSessions.create(customerId, subscriptionIds);
    return session.urls.general.overview;
  }
}
