import { capTierFor, EMAIL_CAP_TIERS, EMAIL_KINDS } from './email';

describe('capTierFor', () => {
  it('puts instant alerts and digests in their own tiers', () => {
    expect(capTierFor('instant_alert')).toBe('instant');
    expect(capTierFor('digest')).toBe('digest');
  });

  it('puts every other kind in the account tier', () => {
    expect(capTierFor('verify')).toBe('account');
    expect(capTierFor('payment_failed')).toBe('account');
  });

  it('gives every kind a tier with a cap', () => {
    for (const kind of EMAIL_KINDS) expect(EMAIL_CAP_TIERS[capTierFor(kind)]).toBeGreaterThan(0);
  });
});
