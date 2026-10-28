import type { PaddleGateway } from '../billing/paddle/gateway';

/** A gateway that never calls Paddle: it records the portal sessions asked for and returns a fixed URL. */
export class FakePaddleGateway implements PaddleGateway {
  readonly portalCalls: { customerId: string; subscriptionIds: string[] }[] = [];

  createPortalSession(customerId: string, subscriptionIds: string[]): Promise<string> {
    this.portalCalls.push({ customerId, subscriptionIds });
    return Promise.resolve(`https://sandbox-customer-portal.paddle.com/fake/${customerId}`);
  }
}
