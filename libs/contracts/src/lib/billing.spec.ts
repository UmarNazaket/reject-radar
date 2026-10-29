import { isPaidSubscriptionStatus, PAID_PLAN_IDS, PAID_SUBSCRIPTION_STATUSES, PADDLE_ENVS, priceCatalog } from './billing';

const prices = {
  PADDLE_PRICE_PRO_MONTHLY: 'pri_01m61npvnr18pc5g8fjpjfnhne',
  PADDLE_PRICE_PRO_YEARLY: 'pri_01m61npw5hf8zddhzww39dmshg',
  PADDLE_PRICE_BUSINESS_MONTHLY: 'pri_01m61npx58trnyzg6z77vywvjk',
  PADDLE_PRICE_BUSINESS_YEARLY: 'pri_01m61npxms42vc5e3pr7r3na4q',
};

describe('billing constants', () => {
  it('lists the Paddle environments and the plans checkout can sell', () => {
    expect(PADDLE_ENVS).toEqual(['sandbox', 'production']);
    expect(PAID_PLAN_IDS).toEqual(['pro', 'business']);
  });

  it('lists the subscription statuses that pay for a plan (P7-D6)', () => {
    expect(PAID_SUBSCRIPTION_STATUSES).toEqual(['active', 'trialing', 'past_due']);
    expect(['active', 'trialing', 'past_due', 'paused', 'canceled', null, undefined].map(isPaidSubscriptionStatus)).toEqual([true, true, true, false, false, false, false]);
  });
});

describe('priceCatalog', () => {
  it('maps both ways', () => {
    const catalog = priceCatalog(prices);
    expect(catalog.byPrice.get('pri_01m61npx58trnyzg6z77vywvjk')).toEqual({
      priceId: 'pri_01m61npx58trnyzg6z77vywvjk',
      plan: 'business',
      interval: 'month',
    });
    expect(catalog.byPrice.get(prices.PADDLE_PRICE_BUSINESS_YEARLY)).toMatchObject({ plan: 'business', interval: 'year' });
    expect(catalog.byPrice.get(prices.PADDLE_PRICE_PRO_MONTHLY)).toMatchObject({ plan: 'pro', interval: 'month' });
    expect(catalog.priceFor('pro', 'year')).toBe('pri_01m61npw5hf8zddhzww39dmshg');
    expect(catalog.priceFor('business', 'month')).toBe('pri_01m61npx58trnyzg6z77vywvjk');
    expect(catalog.byPrice.size).toBe(4);
  });

  it('does not know an unlisted price', () => {
    expect(priceCatalog(prices).byPrice.get('pri_00000000000000000000000000')).toBeUndefined();
  });

  it('rejects duplicate price ids', () => {
    expect(() => priceCatalog({ ...prices, PADDLE_PRICE_PRO_YEARLY: prices.PADDLE_PRICE_PRO_MONTHLY })).toThrow(/duplicate/i);
  });
});
